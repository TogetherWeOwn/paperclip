import { createHash } from "node:crypto";
import { NativeSshAuthorityError } from "./host-executor.js";

/**
 * Exit status the embedded host verifier uses for a refused launch. 125 keeps
 * the lineage of the reviewed host gate (gate.py EXIT_REFUSED): a launch the
 * host refused reads differently from a command that ran and failed.
 */
export const NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT = 125;

/**
 * Seconds of host-clock fast skew tolerated at the expiry check. The host
 * refuses when its own clock reads at or past expiresAt + skew, so a host a
 * few seconds fast cannot falsely refuse a live authority. The window the
 * check bounds grows by the same seconds.
 */
export const NATIVE_SSH_HOST_CLOCK_SKEW_SEC = 5;

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHELL_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Single-quote a value for POSIX sh. Local (not imported from ssh.ts) so this
 * module stays importable from ssh.ts without a cycle; it must stay identical
 * to ssh.ts's shellQuote, pinned by the quoting test below.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function sha256HexUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Shell-tractable binding digest over an ordered list of records: the sha256
 * of the concatenated per-record sha256 hex digests. Fixed-width (64 hex
 * chars) elements keep the concatenation unambiguous with no NUL bytes (which
 * POSIX sh variables cannot hold) and no byte lengths (which ${#var} counts
 * locale-dependently). The host recomputes this exact construction with
 * sha256sum/shasum; see the generated verifier below.
 *
 * This is deliberately NOT the signed canonical-JSON digest: canonical JSON
 * cannot be reproduced exactly in POSIX sh (string escaping, locale-dependent
 * lengths), so the host verifies these equivalent digests over the identical
 * values instead. The signed canonical digests stay verified server-side by
 * assertNativeSshLaunchAuthority before this script is ever built.
 */
export function nativeSshHostBindingDigest(records: readonly string[]): string {
  return sha256HexUtf8(records.map((record) => sha256HexUtf8(record)).join(""));
}

/** Binding digest over the exact argv the host is about to exec. */
export function nativeSshHostArgvDigest(command: string, args: readonly string[]): string {
  return nativeSshHostBindingDigest([command, ...args]);
}

/**
 * Binding digest over the launch environment as `KEY=VALUE` records sorted by
 * key. Keys are `[A-Za-z0-9_]+`, so UTF-16 sort order is byte order and the
 * host needs no sort: the generator emits records pre-sorted.
 */
export function nativeSshHostEnvDigest(env: Readonly<Record<string, string>>): string {
  const keys = Object.keys(env).sort();
  return nativeSshHostBindingDigest(keys.map((key) => `${key}=${env[key]}`));
}

export interface NativeSshHostVerifierBinding {
  /** ISO expiry from the spent proof's authority. */
  readonly expiresAt: string;
  /** Opaque request id from the spent proof's authority; labels refusal lines. */
  readonly opaqueRequestId: string;
}

export interface BuildNativeSshVerifiedRemoteScriptInput {
  /** Login-profile preamble lines, from the ssh lane (trusted, verbatim). */
  readonly profileLines: readonly string[];
  readonly username: string;
  readonly remoteCwd: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The environment the remote command actually gets, after the SSH size budget. */
  readonly launchEnv: Readonly<Record<string, string>>;
  readonly binding: NativeSshHostVerifierBinding;
}

function assertNoNul(value: string, what: string): void {
  if (value.includes("\0")) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      `Native SSH host verification cannot carry a NUL byte in ${what}`,
    );
  }
}

function assertBinding(binding: NativeSshHostVerifierBinding): {
  expiresEpoch: number;
  opaqueRequestId: string;
} {
  if (!binding || typeof binding !== "object") {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires the spent proof's binding",
    );
  }
  if (typeof binding.opaqueRequestId !== "string" || !UUID_RE.test(binding.opaqueRequestId)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a UUID opaque request id",
    );
  }
  const expiresMs = Date.parse(binding.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a valid authority expiry",
    );
  }
  return { expiresEpoch: Math.floor(expiresMs / 1000), opaqueRequestId: binding.opaqueRequestId };
}

/**
 * The verifier &&-links: everything between `cd` and the final exec. Exported
 * separately from the assembled script so execution tests can run the links
 * against real shells without string surgery.
 *
 * Link order is load-bearing: shell state is reset first (a login profile may
 * have set -e/-u or IFS), expected values are assigned, the about-to-exec argv
 * is captured with `set --`, host-observed facts (user, cwd, clock, expiry,
 * hash tool) are checked, the argv digest is verified, the launch env is
 * exported, the env digest is verified over the live variables, and only then
 * does the caller exec "$@" — the same params that were just verified.
 *
 * Every check fails closed with exit 125 and a stderr line naming the opaque
 * request id. Refusal lines carry digests and the opaque id only, never
 * values. All scratch variables are initialized before use and all reads
 * happen in subshells or after assignment, so a launch env key that happens
 * to share the paperclip_ prefix cannot change a check outcome.
 */
export function buildNativeSshHostVerifierLinks(
  input: Omit<BuildNativeSshVerifiedRemoteScriptInput, "profileLines">,
): string[] {
  const { username, remoteCwd, command, args, launchEnv, binding } = input;
  if (typeof username !== "string" || username.length === 0) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a remote username",
    );
  }
  if (typeof remoteCwd !== "string" || remoteCwd.length === 0) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a remote working directory",
    );
  }
  if (typeof command !== "string" || command.length === 0) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a command",
    );
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a string argument list",
    );
  }
  if (!launchEnv || typeof launchEnv !== "object" || Array.isArray(launchEnv)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification requires a launch environment object",
    );
  }
  assertNoNul(username, "the remote username");
  assertNoNul(remoteCwd, "the remote working directory");
  assertNoNul(command, "the command");
  const envKeys = Object.keys(launchEnv).sort();
  for (const key of envKeys) {
    if (!SHELL_ENV_KEY_RE.test(key)) {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        `Native SSH host verification cannot export an invalid environment key: ${key}`,
      );
    }
    const value = launchEnv[key];
    if (typeof value !== "string") {
      throw new NativeSshAuthorityError(
        "native_ssh_authority_invalid",
        `Native SSH host verification requires string environment values: ${key}`,
      );
    }
    assertNoNul(value, `environment value ${key}`);
  }
  for (const arg of args) assertNoNul(arg, "an argument");
  const { expiresEpoch, opaqueRequestId } = assertBinding(binding);

  const argvDigest = nativeSshHostArgvDigest(command, args);
  const envDigest = nativeSshHostEnvDigest(launchEnv);
  if (!SHA256_RE.test(argvDigest) || !SHA256_RE.test(envDigest)) {
    throw new NativeSshAuthorityError(
      "native_ssh_authority_invalid",
      "Native SSH host verification produced a malformed digest",
    );
  }

  // `pwd` after `cd` prints the logical path without trailing slashes; the
  // expected value is normalized the same way. A relative remoteCwd cannot be
  // compared against `pwd` output, so the cwd check is emitted only for
  // absolute paths; the server-side authority still binds it either way.
  const absoluteCwd = remoteCwd.startsWith("/");
  const normalizedCwd = absoluteCwd ? remoteCwd.replace(/\/+$/, "") || "/" : remoteCwd;

  const R = NATIVE_SSH_HOST_VERIFY_REFUSAL_EXIT;
  const refuse = (reason: string): string =>
    `echo "paperclip: native SSH launch $paperclip_opaque_id refused on host: ${reason}" >&2; exit ${R}`;
  const hashChain =
    `paperclip_e=$(printf '%s' "$paperclip_item" | $paperclip_sha256 | cut -d' ' -f1) || exit ${R}; ` +
    `paperclip_h="$paperclip_h$paperclip_e"`;
  const hashFinal = (expectedVar: string, reason: string): string =>
    `paperclip_h=$(printf '%s' "$paperclip_h" | $paperclip_sha256 | cut -d' ' -f1) || exit ${R}; ` +
    `if [ "$paperclip_h" != "$${expectedVar}" ]; then ${refuse(reason)}; fi`;

  const argvSubshell =
    `( paperclip_h=''; paperclip_item=''; for paperclip_item in "$@"; do ${hashChain}; done; ` +
    `${hashFinal("paperclip_expected_argv", "command does not match the launch authority")} )`;
  const envWords = envKeys.map((key) => `"${key}=$${key}"`).join(" ");
  const envSubshell =
    `( paperclip_h=''; paperclip_item=''; for paperclip_item in${envWords ? ` ${envWords}` : ""}; do ` +
    `${hashChain}; done; ${hashFinal("paperclip_expected_env", "environment does not match the launch authority")} )`;

  return [
    "set +e +u",
    "unset IFS",
    `paperclip_expected_argv='${argvDigest}'`,
    `paperclip_expected_env='${envDigest}'`,
    `paperclip_expected_user=${shellQuote(username)}`,
    ...(absoluteCwd ? [`paperclip_expected_cwd=${shellQuote(normalizedCwd)}`] : []),
    `paperclip_expires_at='${expiresEpoch + NATIVE_SSH_HOST_CLOCK_SKEW_SEC}'`,
    `paperclip_opaque_id=${shellQuote(opaqueRequestId)}`,
    `set -- ${[command, ...args].map((word) => shellQuote(word)).join(" ")}`,
    `if [ "$(id -un)" != "$paperclip_expected_user" ]; then ${refuse("unexpected remote user")}; fi`,
    ...(absoluteCwd
      ? [
          `if [ "$(pwd)" != "$paperclip_expected_cwd" ] && [ "$(pwd -P)" != "$paperclip_expected_cwd" ]; then ${refuse("unexpected working directory")}; fi`,
        ]
      : []),
    "paperclip_now=$(date +%s)",
    `case $paperclip_now in ''|*[!0-9]*) ${refuse("host clock is unreadable")};; esac`,
    `if [ "$paperclip_now" -ge "$paperclip_expires_at" ]; then ${refuse("launch authority expired")}; fi`,
    `if command -v sha256sum >/dev/null 2>&1; then paperclip_sha256='sha256sum'; elif command -v shasum >/dev/null 2>&1; then paperclip_sha256='shasum -a 256'; else ${refuse("no sha256 tool on host")}; fi`,
    argvSubshell,
    ...envKeys.map((key) => `export ${key}=${shellQuote(launchEnv[key])}`),
    envSubshell,
  ];
}

/**
 * The full remote script for an authority-carrying launch: login profiles,
 * `cd`, the verifier links, then `exec "$@"` on the verified params. Only
 * callers holding a spent proof may use this; everyone else keeps the legacy
 * script.
 */
export function buildNativeSshVerifiedRemoteScript(
  input: BuildNativeSshVerifiedRemoteScriptInput,
): string {
  return [
    ...input.profileLines,
    `cd ${shellQuote(input.remoteCwd)}`,
    ...buildNativeSshHostVerifierLinks(input),
    `exec "$@"`,
  ].join(" && ");
}
