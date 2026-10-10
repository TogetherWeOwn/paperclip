/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No plaintext secrets in files:
 * the optional credential cache is sealed with a key derived from the run's broker capability. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
// Git subcommands that never contact a remote and never read the managed
// identity. Anything else (network commands, commit-writing commands, aliases,
// unknown commands) still captures credentials for the operation.
const LOCAL_GIT_COMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'branch', 'worktree', 'ls-files', 'ls-tree',
  'cat-file', 'config', 'init', 'add', 'rm', 'mv', 'restore', 'checkout', 'switch', 'reset', 'grep', 'blame',
  'describe', 'diff-tree', 'diff-index', 'diff-files', 'for-each-ref', 'show-ref', 'symbolic-ref', 'update-ref',
  'merge-base', 'name-rev', 'shortlog', 'reflog', 'check-ignore', 'check-attr', 'check-ref-format', 'hash-object',
  'write-tree', 'read-tree', 'update-index', 'count-objects', 'clean', 'apply', 'format-patch', 'stripspace',
  'mktree', 'help', 'version', 'sparse-checkout', 'range-diff', 'whatchanged', 'show-branch', 'cherry',
]);
const LOCAL_REMOTE_SUBCOMMANDS = new Set(['add', 'get-url', 'set-url', 'rename', 'remove', 'rm', '-v', '--verbose']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--list-cmds']);
function gitInvocation(args) {
  const globals = [];
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const arg = args[index];
    globals.push(arg);
    index++;
    if (GIT_OPTIONS_WITH_VALUE.has(arg) && index < args.length) globals.push(args[index++]);
  }
  return { globals, command: args[index] || null, rest: args.slice(index + 1) };
}
function gitNeedsCredentials(args, realGit, env) {
  const { globals, command, rest } = gitInvocation(args);
  if (!command) return false;
  let local = LOCAL_GIT_COMMANDS.has(command);
  if (command === 'remote') local = rest.length === 0 || LOCAL_REMOTE_SUBCOMMANDS.has(rest[0]);
  if (!local) return true;
  // Partial clones fetch missing objects on demand during otherwise local
  // commands (checkout, diff, show, blame), which needs the remote credential.
  const probe = spawnSync(realGit, [...globals, 'config', '--get', 'extensions.partialClone'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return probe.status === 0 && probe.stdout.trim() !== '';
}
const CACHE_MAX_TTL_MS = 10 * 60 * 1000;
const CACHE_NEGATIVE_TTL_MS = 60 * 1000;
function credentialCache(env, url, capability, bridgeToken) {
  const requested = Number(env.PAPERCLIP_GITHUB_CREDENTIAL_CACHE_TTL_MS);
  const ttl = Number.isFinite(requested) && env.PAPERCLIP_GITHUB_CREDENTIAL_CACHE_TTL_MS !== ''
    ? Math.max(0, Math.min(CACHE_MAX_TTL_MS, requested)) : CACHE_MAX_TTL_MS;
  if (ttl === 0) return null;
  // Only a holder of this run's broker capability can open the entry, and that
  // holder could call the broker directly, so the sealed file grants nothing new.
  const key = crypto.createHash('sha256').update(['paperclip-github-credential-cache-v1', url, capability, bridgeToken].join('\0')).digest();
  const file = path.join(directory, 'credential-cache', crypto.createHash('sha256').update(key).digest('hex').slice(0, 32) + '.json');
  return {
    read() {
      try {
        const sealed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        const entry = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
        if (typeof entry.expiresAt !== 'number' || entry.expiresAt <= Date.now() || entry.expiresAt > Date.now() + CACHE_MAX_TTL_MS) return null;
        return entry.result;
      } catch { return null; }
    },
    write(result) {
      try {
        const lifetime = result.status === 'available' ? ttl : Math.min(ttl, CACHE_NEGATIVE_TTL_MS);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([cipher.update(JSON.stringify({ expiresAt: Date.now() + lifetime, result }), 'utf8'), cipher.final()]);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
        fs.writeFileSync(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
        fs.renameSync(temporary, file);
      } catch {}
    },
  };
}
async function main() {
  let env = { ...process.env };
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    // Local Git needs neither a remote credential nor the managed identity.
    const wantsCredentials = program === 'gh' || gitNeedsCredentials(process.argv.slice(2), executable, env);
    try {
    if (!wantsCredentials) {
    } else if (base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      const bridgeToken = env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN;
      const cache = credentialCache(env, url, env.PAPERCLIP_GITHUB_BROKER_TOKEN, bridgeToken);
      let result = cache ? cache.read() : null;
      if (!result) {
        let response;
        for (let attempt = 0; attempt < 30; attempt++) {
          response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { authorization: 'Bearer ' + bridgeToken,
              'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status !== 409) break;
          await response.arrayBuffer();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!response.ok) {
          diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
        } else {
          result = await response.json();
          if (cache && result && typeof result.status === 'string') cache.write(result);
        }
      }
      if (result) {
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
