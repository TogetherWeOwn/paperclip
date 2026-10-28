import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const gate = workflow.split('      - name: Block unregenerable lockfile edits\n')[1]
  .split('        run: |\n')[1].split('\n      - name:')[0]
  .split('\n').map(line => line.slice(10)).join('\n');

function gateRuns({ author = 'contributor', branch = 'feature/deps', headRepo = 'TogetherWeOwn/paperclip', base = 'master' } = {}) {
  const condition = workflow.split('      - name: Block unregenerable lockfile edits\n')[1]
    .split('        if: >-\n')[1].split('        shell:')[0].trim();
  // These expressions use the common JS/Actions boolean subset.
  return Function('github', 'steps', 'startsWith', `return (${condition});`)(
    { repository: 'TogetherWeOwn/paperclip', head_ref: branch, event: { pull_request: { user: { login: author }, head: { repo: { full_name: headRepo } } } } },
    { base: { outputs: { ref: base } } },
    (value, prefix) => value.startsWith(prefix),
  );
}

test('refresh exemptions require both the bot author and a same-repository head', () => {
  for (const branch of ['chore/refresh-lockfile', 'chore/refresh-lockfile-deploy-tog6']) {
    assert.equal(gateRuns({ branch, headRepo: 'attacker/paperclip' }), true);
    assert.equal(gateRuns({ branch, headRepo: 'attacker/paperclip', author: 'github-actions[bot]' }), true);
    assert.equal(gateRuns({ branch }), true);
    assert.equal(gateRuns({ branch, author: 'github-actions[bot]' }), false);
  }
  assert.equal(gateRuns({ author: 'github-actions[bot]' }), true);
  assert.equal(gateRuns({ author: 'dependabot[bot]' }), false);
});

test('deploy release lines retain their existing reviewed repair exemption', () => {
  assert.equal(gateRuns({ base: 'deploy/release' }), false);
  assert.equal(gateRuns({ base: 'deployment-not-a-release-line' }), true);
});

function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(directory, message) {
  git(directory, 'add', '.');
  git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', message);
  return git(directory, 'rev-parse', 'HEAD');
}

function runGate({ manifest = true, lockfile = true, reproducible = true, resolverFails = false, lookalike = false, extraPaths = 0, nestedManifest = false, mergeRef = false, advancedBaseLockfile = false } = {}) {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'lockfile-gate-'));
  try {
    git(directory, 'init', '-q');
    writeFileSync(join(directory, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'base\n');
    const base = commit(directory, 'base');
    if (manifest) {
      const manifestDirectory = nestedManifest ? join(directory, 'workspace\nwith-unicode-λ') : directory;
      mkdirSync(manifestDirectory, { recursive: true });
      writeFileSync(join(manifestDirectory, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
    }
    if (lookalike) writeFileSync(join(directory, 'notpackage.json'), '{}\n');
    for (let index = 0; index < extraPaths; index++) {
      writeFileSync(join(directory, `zz-${String(index).padStart(4, '0')}-${'x'.repeat(180)}.txt`), 'fixture\n');
    }
    if (lockfile) writeFileSync(join(directory, 'pnpm-lock.yaml'), 'generated\n');
    writeFileSync(join(directory, 'README.md'), 'fixture\n');
    const head = commit(directory, 'head');
    let baseTip = base;
    if (mergeRef || advancedBaseLockfile) {
      git(directory, 'checkout', '--detach', base);
      if (advancedBaseLockfile) {
        writeFileSync(join(directory, 'pnpm-lock.yaml'), 'unrelated-base-tip-lockfile\n');
        baseTip = commit(directory, 'base lockfile moved');
        git(directory, 'checkout', '--detach', head);
      } else {
        mkdirSync(join(directory, 'base-only-workspace'));
        // Simulate master landing a manifest without its bot-refreshed lockfile.
        writeFileSync(join(directory, 'base-only-workspace/package.json'), '{"name":"base-only","dependencies":{"new-dep":"^1.0.0"}}\n');
        baseTip = commit(directory, 'stale master lockfile');
        git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'merge', '--no-ff', '-qm', 'merge ref', head);
      }
    }
    const original = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
    const bin = join(directory, 'bin');
    const temporary = join(directory, 'temporary');
    mkdirSync(bin);
    mkdirSync(temporary);
    writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'install --resolution-only --ignore-scripts --ignore-pnpmfile --no-frozen-lockfile' ]]
printf 'called' > "$RESOLVER_MARKER"
[[ "$(cat pnpm-lock.yaml)" == 'base' ]]
[[ ! -e base-only-workspace/package.json ]]
printf '${reproducible ? 'generated' : 'different'}\\n' > pnpm-lock.yaml
exit ${resolverFails ? 42 : 0}
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', gate], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: baseTip, HEAD_SHA: head, RUNNER_TEMP: temporary, PATH: `${bin}:${process.env.PATH}`, RESOLVER_MARKER: join(directory, 'resolver-called') },
    });
    assert.equal(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8'), original, 'the gate must restore the committed PR lockfile');
    result.resolverCalled = existsSync(join(directory, 'resolver-called'));
    assert.equal(git(directory, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1, 'the proof worktree must be removed on every exit');
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('gate admits a manifest change with a reproducible lockfile', () => {
  const result = runGate();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.resolverCalled, true);
  assert.match(result.stdout, /Lockfile hunk verified/);
});

test('gate proves the PR head, not a merge ref with unrelated stale base manifests', () => {
  const result = runGate({ mergeRef: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.resolverCalled, true);
  assert.match(result.stdout, /Lockfile hunk verified/);
});

test('gate seeds resolution from the merge base even when the base-tip lockfile moved', () => {
  const result = runGate({ advancedBaseLockfile: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.resolverCalled, true);
  assert.match(result.stdout, /Lockfile hunk verified/);
});

test('a mismatch remains rejected but explains registry drift and the recovery command', () => {
  const result = runGate({ reproducible: false });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /registry.*(changed|drift)/i);
  assert.match(result.stdout, /merge.*base.*regenerate/i);
  assert.match(result.stdout, /pnpm install --resolution-only --ignore-scripts --ignore-pnpmfile --no-frozen-lockfile/);
  assert.doesNotMatch(result.stdout, /instead of hand-editing|of hand-editing/);
});

test('gate rejects a lockfile-only change', () => {
  const result = runGate({ manifest: false });
  assert.equal(result.status, 1);
  assert.equal(result.resolverCalled, false);
  assert.match(result.stdout, /without a package.json change/);
});

test('gate rejects a filename that only ends in package.json', () => {
  assert.equal(runGate({ manifest: false, lookalike: true }).status, 1);
});

test('gate rejects a manifest change with an unregenerable lockfile', () => {
  const result = runGate({ reproducible: false });
  assert.equal(result.status, 1);
  assert.equal(result.resolverCalled, true);
  assert.match(result.stdout, /does not match/);
});

test('gate preserves resolver failure and restores the PR lockfile', () => {
  assert.equal(runGate({ resolverFails: true }).status, 42);
});

test('gate accepts a PR with no lockfile change without invoking the resolver', () => {
  const result = runGate({ lockfile: false, resolverFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.resolverCalled, false);
  assert.doesNotMatch(result.stdout, /Lockfile hunk verified/);
});

test('large diffs cannot skip lockfile-only rejection', () => {
  const result = runGate({ manifest: false, extraPaths: 1200 });
  assert.equal(result.status, 1);
  assert.equal(result.resolverCalled, false);
  assert.match(result.stdout, /without a package.json change/);
});

test('large diffs still resolve and reject corrupt lockfiles', () => {
  const result = runGate({ reproducible: false, extraPaths: 1200 });
  assert.equal(result.status, 1);
  assert.equal(result.resolverCalled, true);
  assert.match(result.stdout, /does not match/);
});

test('large diffs still resolve and admit reproducible lockfiles', () => {
  const result = runGate({ extraPaths: 1200 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.resolverCalled, true);
  assert.match(result.stdout, /Lockfile hunk verified/);
});

test('gate recognizes workspace manifests with newline and Unicode paths', () => {
  const result = runGate({ nestedManifest: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.resolverCalled, true);
});

test('real pnpm hooks cannot forge a regenerable lockfile', () => {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'lockfile-hook-'));
  try {
    const temporary = join(directory, 'temporary');
    const home = join(directory, 'home');
    mkdirSync(temporary);
    mkdirSync(home);
    // No dependency downloads, ambient credentials, or user pnpm configuration.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      CI: 'true',
      COREPACK_ENABLE_PROJECT_SPEC: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      npm_config_offline: 'true',
    };
    const manifest = { name: 'hook-fixture', version: '1.0.0', packageManager: 'pnpm@9.15.4' };
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`);
    const pnpm = (...args) => {
      const result = spawnSync('pnpm', args, { cwd: directory, env, encoding: 'utf8', timeout: 60_000 });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      return result.stdout.trim();
    };
    assert.equal(pnpm('--version'), '9.15.4');
    const install = ['install', '--resolution-only', '--ignore-scripts', '--no-frozen-lockfile'];
    pnpm(...install);
    git(directory, 'init', '-q');
    git(directory, 'add', 'package.json', 'pnpm-lock.yaml');
    git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base');
    const base = git(directory, 'rev-parse', 'HEAD');
    mkdirSync(join(directory, 'local'));
    writeFileSync(join(directory, 'local/package.json'), '{"name":"local","version":"1.0.0"}\n');
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ ...manifest, version: '2.0.0', dependencies: { local: 'link:./local' } })}\n`);
    pnpm(...install, '--ignore-pnpmfile');
    const cleanLockfile = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(join(directory, '.pnpmfile.cjs'), `module.exports = {
  hooks: {
    afterAllResolved(lockfile) {
      require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'hook-called'))}, 'called');
      lockfile.hookProof = 'forged';
      return lockfile;
    },
  },
};
`);
    pnpm(...install);
    const forgedLockfile = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
    assert.match(forgedLockfile, /hookProof: forged/);
    assert.equal(existsSync(join(directory, 'hook-called')), true, '--ignore-scripts alone executes pnpm hooks');
    git(directory, 'add', 'package.json', 'pnpm-lock.yaml', '.pnpmfile.cjs', 'local/package.json');
    git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'head');
    let head = git(directory, 'rev-parse', 'HEAD');
    const run = (script) => spawnSync('bash', ['-c', script], {
      cwd: directory,
      env: { ...env, BASE_SHA: base, HEAD_SHA: head, RUNNER_TEMP: temporary },
      encoding: 'utf8',
      timeout: 60_000,
    });
    rmSync(join(directory, 'hook-called'));
    const unsafe = run(gate.replace('--ignore-pnpmfile ', ''));
    assert.equal(unsafe.status, 0, unsafe.stderr);
    assert.equal(existsSync(join(directory, 'hook-called')), true);
    assert.equal(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8'), forgedLockfile);

    rmSync(join(directory, 'hook-called'));
    const safe = run(gate);
    assert.equal(safe.status, 1, safe.stderr);
    assert.match(safe.stdout, /does not match/);
    assert.equal(existsSync(join(directory, 'hook-called')), false, 'the actual gate must not execute PR hooks');
    assert.equal(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8'), forgedLockfile, 'rejecting must restore the PR lockfile');

    // An unused pnpmfile does not forbid an otherwise reproducible lockfile.
    writeFileSync(join(directory, 'pnpm-lock.yaml'), cleanLockfile);
    git(directory, 'add', 'pnpm-lock.yaml');
    git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'honest lockfile');
    head = git(directory, 'rev-parse', 'HEAD');
    const honest = run(gate);
    assert.equal(honest.status, 0, honest.stderr);
    assert.match(honest.stdout, /Lockfile hunk verified/);
    assert.equal(existsSync(join(directory, 'hook-called')), false);
    assert.equal(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8'), cleanLockfile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
