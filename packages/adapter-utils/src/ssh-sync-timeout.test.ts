import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSshSyncTimeoutError, SshSyncTimeoutError, syncDirectoryToSsh, type SshRemoteExecutionSpec } from "./ssh.js";

// A fake `ssh` that records its pid and then hangs forever without reading
// stdin: the shape of a stalled remote that would otherwise hold the caller's
// lease indefinitely.
const HANGING_SSH = `#!/bin/sh
echo $$ > "$STUB_SSH_PID_FILE"
exec sleep 60
`;

const originalPath = process.env.PATH ?? "";
let scratch: string | undefined;

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.STUB_SSH_PID_FILE;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("syncDirectoryToSsh timeout", () => {
  it("kills the spawned transfer on expiry and rejects with a recognisable timeout error", async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "ssh-sync-timeout-"));
    const bin = path.join(scratch, "bin");
    const local = path.join(scratch, "local");
    await mkdir(bin);
    await mkdir(local);
    await writeFile(path.join(local, "payload.bin"), Buffer.alloc(4 * 1024 * 1024, 7));
    await writeFile(path.join(bin, "ssh"), HANGING_SSH, { mode: 0o755 });
    const pidFile = path.join(scratch, "ssh.pid");
    process.env.STUB_SSH_PID_FILE = pidFile;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const spec = { host: "192.0.2.1", port: 22, username: "nobody", remoteCwd: "/tmp", strictHostKeyChecking: false } as SshRemoteExecutionSpec;

    const started = Date.now();
    const error = await syncDirectoryToSsh({ spec, localDir: local, remoteDir: "/remote/artifact", timeoutMs: 400 }).then(() => null, e => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(SshSyncTimeoutError);
    expect(isSshSyncTimeoutError(error)).toBe(true);
    expect(isSshSyncTimeoutError(new Error("ssh exited with code 255"))).toBe(false);

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
    // Explicit timeout: the 5s default is tighter than this test's own
    // worst case (400ms transfer timeout plus the 5s reap poll).
  }, 30_000);

  it("rejects with the ssh failure (no EPIPE crash, no stuck tar) when ssh exits before reading the archive", async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "ssh-sync-early-exit-"));
    const bin = path.join(scratch, "bin");
    const local = path.join(scratch, "local");
    await mkdir(bin);
    await mkdir(local);
    await writeFile(path.join(local, "payload.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
    await writeFile(path.join(bin, "ssh"), "#!/bin/sh\necho 'stub: connection refused' >&2\nexit 255\n", { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const spec = { host: "192.0.2.1", port: 22, username: "nobody", remoteCwd: "/tmp", strictHostKeyChecking: false } as SshRemoteExecutionSpec;
    const error = await syncDirectoryToSsh({ spec, localDir: local, remoteDir: "/remote/artifact", timeoutMs: 20_000 }).then(() => null, e => e);
    expect(isSshSyncTimeoutError(error)).toBe(false);
    expect(String(error?.message)).toContain("connection refused");
    // Explicit timeout: this spawn+pipe+8MB transfer tripped the 5s default
    // once under workspaces-b shard load (paperclip#242, head becf6cd). The
    // settle path is correct — every tar/ssh outcome resolves in ms — so a
    // 5s stall is executor starvation, not a product hang; give it room.
  }, 30_000);
});
