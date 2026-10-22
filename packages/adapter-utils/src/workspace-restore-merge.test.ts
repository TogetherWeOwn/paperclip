import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";
import {
  captureDirectorySnapshot,
  directorySnapshotSha256,
  classifyWorkspaceRestoreFailure,
  describeWorkspaceRestoreFailure,
  mergeChangedFilesWithBaseline,
  mergeDirectoryWithBaseline,
  parseDirectorySnapshot,
  serializeDirectorySnapshot,
  withDirectoryMergeLock,
  WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
} from "./workspace-restore-merge.js";

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("round-trips a deterministic durable snapshot and rejects traversal", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-snapshot-"),
    );
    cleanupDirs.push(rootDir);
    await mkdir(path.join(rootDir, "nested"), { recursive: true });
    await writeFile(path.join(rootDir, "b.txt"), "bravo\n", "utf8");
    await writeFile(path.join(rootDir, "nested", "a.txt"), "alpha\n", "utf8");

    const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });
    const serialized = serializeDirectorySnapshot(snapshot);
    const restored = parseDirectorySnapshot(serialized);

    expect(serialized.entries.map(([relativePath]) => relativePath)).toEqual([
      "b.txt",
      "nested",
      "nested/a.txt",
    ]);
    expect(restored).not.toBeNull();
    expect(directorySnapshotSha256(restored!)).toBe(
      directorySnapshotSha256(snapshot),
    );
    expect(
      parseDirectorySnapshot({
        ...serialized,
        entries: [["../escape", serialized.entries[0]![1]]],
      }),
    ).toBeNull();
  });

  it("preserves sibling files when sequential stale-baseline restores create the same nested directory tree", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);

    const targetDir = path.join(rootDir, "target");
    const sourceADir = path.join(rootDir, "source-a");
    const sourceBDir = path.join(rootDir, "source-b");
    await mkdir(targetDir, { recursive: true });
    await mkdir(path.join(sourceADir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });
    await mkdir(path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh"), { recursive: true });

    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });

    await writeFile(
      path.join(sourceADir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"),
      "ssh claude\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceBDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"),
      "ssh codex\n",
      "utf8",
    );

    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceADir,
      targetDir,
    });
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: sourceBDir,
      targetDir,
    });

    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "claude_local.md"), "utf8"),
    ).resolves.toBe("ssh claude\n");
    await expect(
      readFile(path.join(targetDir, "manual-qa", "environment-matrix", "ssh", "codex_local.md"), "utf8"),
    ).resolves.toBe("ssh codex\n");
  });

  it.each(["file", "symlink"] as const)("refuses %s replacement of an excluded path's ancestor before any restore writes", async (kind) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-protected-"));
    cleanupDirs.push(rootDir);
    const targetDir = path.join(rootDir, "target");
    const sourceDir = path.join(rootDir, "source");
    const skipped = ".paperclip-repositories/toolkit-stripped";
    await mkdir(path.join(targetDir, skipped), { recursive: true });
    await mkdir(sourceDir);
    await writeFile(path.join(targetDir, skipped, "survivor.txt"), "kept\n");
    await writeFile(path.join(targetDir, "a.txt"), "original\n");
    const baseline = await captureDirectorySnapshot(targetDir, { exclude: [skipped] });
    await writeFile(path.join(sourceDir, "a.txt"), "changed\n");
    if (kind === "file") {
      await writeFile(path.join(sourceDir, ".paperclip-repositories"), "replacement\n");
    } else {
      await mkdir(path.join(sourceDir, "moved-repositories"));
      await symlink("moved-repositories", path.join(sourceDir, ".paperclip-repositories"));
    }
    const beforeApply = vi.fn();
    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir, beforeApply }))
      .rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    expect(beforeApply).not.toHaveBeenCalled();
    expect(await readFile(path.join(targetDir, skipped, "survivor.txt"), "utf8")).toBe("kept\n");
    expect(await readFile(path.join(targetDir, "a.txt"), "utf8")).toBe("original\n");
  });

  it("ignores non-file entries when capturing snapshots", async () => {
    if (process.platform === "win32") return;

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
    cleanupDirs.push(rootDir);
    const socketPath = path.join(rootDir, "runtime.sock");
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const snapshot = await captureDirectorySnapshot(rootDir, { exclude: [] });

      expect(snapshot.entries.has("runtime.sock")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("classifyWorkspaceRestoreFailure", () => {
    it.each([
      "Daytona syncOut refusing tarball with an unparseable entry listing: private listing",
      "Daytona syncOut refusing unparseable or ambiguous symlink entry: private listing",
      "Daytona syncOut refusing unparseable or ambiguous hardlink entry: private listing",
      "Daytona syncOut refusing tarball member that escapes the extraction dir: ../private",
      "Daytona syncOut refusing tarball link whose target escapes the extraction dir: link -> /private",
      "Daytona sync source path is not a confined absolute path: ../private",
      "Daytona sync source path escapes the workspace remote dir: /private",
      ...[40, 41, 42, 44, 45].map((code) => `Daytona outbound symlink-escape guard command failed (exit ${code}): private detail`),
    ])("holds the deterministic confinement refusal: %s", (message) => {
      expect(classifyWorkspaceRestoreFailure(new Error(message))).toBe("restore_unsafe_archive");
      expect(describeWorkspaceRestoreFailure(classifyWorkspaceRestoreFailure(new Error(message)))).not.toContain("private");
    });

    it("preserves the generic policy for other outbound command failures", () => {
      expect(classifyWorkspaceRestoreFailure(new Error("Daytona outbound symlink-escape guard command failed (exit 1): transport failed"))).toBe("restore_failed");
    });

    it("maps an EACCES error to restore_permission_denied", () => {
      const error: NodeJS.ErrnoException = new Error("permission denied");
      error.code = "EACCES";
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_permission_denied");
    });

    it("maps an EPERM error to restore_permission_denied", () => {
      const error: NodeJS.ErrnoException = new Error("operation not permitted");
      error.code = "EPERM";
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_permission_denied");
    });

    it("maps the lock-timeout code to restore_lock_timeout", () => {
      const error: NodeJS.ErrnoException = new Error("Timed out waiting for workspace restore lock at /some/path");
      error.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
      expect(classifyWorkspaceRestoreFailure(error)).toBe("restore_lock_timeout");
    });

    it("maps an unrecognized error, a string, and null to the default restore_failed code", () => {
      expect(classifyWorkspaceRestoreFailure(new Error("some other failure"))).toBe("restore_failed");
      expect(classifyWorkspaceRestoreFailure("a plain string")).toBe("restore_failed");
      expect(classifyWorkspaceRestoreFailure(null)).toBe("restore_failed");
    });
  });

  describe("describeWorkspaceRestoreFailure", () => {
    it("returns one fixed diagnostic line per allowlisted code, and no other text", () => {
      expect(describeWorkspaceRestoreFailure("restore_permission_denied")).toBe(
        "the restore could not write to the workspace (permission denied)",
      );
      expect(describeWorkspaceRestoreFailure("restore_lock_timeout")).toBe(
        "the restore timed out waiting for the workspace merge lock",
      );
      expect(describeWorkspaceRestoreFailure("restore_failed")).toBe("the restore failed");
    });

    it("never reflects a sentinel host path or process id, however the caught error is classified", () => {
      const sentinelPath = "/srv/telemetry-backend";
      const sentinelPid = String(process.pid);
      const error: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, mkdir '${sentinelPath}.paperclip-restore.lock' (pid ${sentinelPid})`,
      );
      error.code = "EACCES";

      const line = describeWorkspaceRestoreFailure(classifyWorkspaceRestoreFailure(error));

      expect(line).not.toContain(sentinelPath);
      expect(line).not.toContain(sentinelPid);
      expect(line).not.toContain(error.message);
    });
  });

  describe("instance-scoped directory merge lock", () => {
    // Points PAPERCLIP_HOME (and, where noted, PAPERCLIP_INSTANCE_ID) at a
    // temporary directory so the lock root never touches the real Paperclip
    // instance, then restores the previous values. Mirrors the save-and-restore
    // pattern in acpx-engine/execute.test.ts.
    let previousHome: string | undefined;
    let previousInstanceId: string | undefined;

    function useTempPaperclipHome(homeDir: string, instanceId: string): void {
      previousHome = process.env.PAPERCLIP_HOME;
      previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    }

    afterEach(() => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      previousHome = undefined;
      previousInstanceId = undefined;
    });

    it.skipIf(process.platform === "win32")(
      "restores successfully when the parent directory of the target is not writable",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        // The old lock sat beside the target, so it needed mkdir rights in the
        // target's parent. The new lock root lives under PAPERCLIP_HOME instead,
        // so a read-only parent must no longer block a restore.
        const readOnlyParent = path.join(rootDir, "read-only-parent");
        const targetDir = path.join(readOnlyParent, "target");
        const sourceDir = path.join(rootDir, "source");
        await mkdir(targetDir, { recursive: true });
        await mkdir(sourceDir, { recursive: true });

        const baseline = await captureDirectorySnapshot(targetDir, { exclude: [] });
        await writeFile(path.join(sourceDir, "new-file.md"), "new content\n", "utf8");

        await chmod(readOnlyParent, 0o500);
        try {
          await mergeDirectoryWithBaseline({ baseline, sourceDir, targetDir });
        } finally {
          // Restore write access so the outer afterEach can remove rootDir.
          await chmod(readOnlyParent, 0o700).catch(() => undefined);
        }

        await expect(readFile(path.join(targetDir, "new-file.md"), "utf8")).resolves.toBe("new content\n");
      },
    );

    it.skipIf(process.platform === "win32")(
      "acquires the same lock for two alias paths that resolve to one canonical target",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        const paperclipHome = path.join(rootDir, "paperclip-home");
        useTempPaperclipHome(paperclipHome, "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");

        let lockNameViaTarget = "";
        await withDirectoryMergeLock(targetDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaTarget = entries[0] ?? "";
        });

        let lockNameViaAlias = "";
        await withDirectoryMergeLock(aliasDir, async () => {
          const entries = await readdir(lockRootDir);
          lockNameViaAlias = entries[0] ?? "";
        });

        expect(lockNameViaTarget).not.toBe("");
        expect(lockNameViaAlias).toBe(lockNameViaTarget);
      },
    );

    it("rejects a lock root that already exists as a symlink", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(locksDir, { recursive: true });
      await mkdir(decoyDir, { recursive: true });
      await symlink(decoyDir, path.join(locksDir, "directory-merge"));

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("rejects a lock root that already exists as a non-directory", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const locksDir = path.join(paperclipHome, "instances", "test-instance", "locks");
      await mkdir(locksDir, { recursive: true });
      await writeFile(path.join(locksDir, "directory-merge"), "not a directory\n", "utf8");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
        /not a plain directory/,
      );
    });

    it("closes the create/validate TOCTOU window: rejects a lock root a racing writer swapped for a symlink during creation", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });
      const decoyDir = path.join(rootDir, "decoy");
      await mkdir(decoyDir, { recursive: true });
      // Pre-create the lock root's parent, so the mock below only has to
      // reproduce what `fs.mkdir({ recursive: true })` does to the leaf path.
      await mkdir(path.join(paperclipHome, "instances", "test-instance", "locks"), { recursive: true });

      // Real `fs.mkdir({ recursive: true })` does not fail on a leaf that
      // already exists as a symlink to a real directory. This stub reproduces
      // exactly that: it plants a symlink to the attacker-controlled decoy
      // directory in the window between the resolver's own "does the root
      // exist yet" check and its own `mkdir` call, then resolves the way a
      // real `mkdir` would (silently) — proving the resolver must validate
      // what `mkdir` actually left behind, not trust that the call resolved.
      const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockImplementationOnce(async (dirPath) => {
        await symlink(decoyDir, dirPath as string);
        return undefined;
      });

      try {
        await expect(withDirectoryMergeLock(targetDir, async () => undefined)).rejects.toThrow(
          /not a plain directory/,
        );
      } finally {
        mkdirSpy.mockRestore();
      }
    });

    it("creates the lock root at mode 0o700 and removes the lock directory after release", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      let entriesDuringLock: string[] = [];
      await withDirectoryMergeLock(targetDir, async () => {
        entriesDuringLock = await readdir(lockRootDir);
      });

      expect((await stat(lockRootDir)).mode & 0o777).toBe(0o700);
      expect(entriesDuringLock).toHaveLength(1);
      await expect(readdir(lockRootDir)).resolves.toHaveLength(0);
    });

    it("classifies the real lock-timeout error by its stable code, never by the message text", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      // Pre-create the lock directory a live process holds, so `isLockStale`
      // never reports it stale and the retry loop can only leave through the
      // deadline check. The owner pid is this test process, which stays alive.
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      const heldLockDir = path.join(lockRootDir, `${lockKey}.lock`);
      await mkdir(heldLockDir, { recursive: true });
      await writeFile(
        path.join(heldLockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );

      // Reach the real deadline without a real 30-second wait: the first
      // `Date.now()` call computes the deadline (unchanged), and every call
      // after reports a time far past it, so the retry loop's own deadline
      // check — not a mocked message or a shortened constant — throws.
      const realNow = Date.now();
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementationOnce(() => realNow)
        .mockImplementation(() => Number.MAX_SAFE_INTEGER);
      let caughtError: NodeJS.ErrnoException | undefined;
      try {
        await withDirectoryMergeLock(targetDir, async () => undefined);
      } catch (error) {
        caughtError = error as NodeJS.ErrnoException;
      } finally {
        dateNowSpy.mockRestore();
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError?.code).toBe(WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE);
      // The classifier reads only `code`; prove the message text carries no
      // trace of the classified outcome, so a message-text match could not
      // have produced this result.
      expect(caughtError?.message).not.toContain("restore_lock_timeout");
      expect(classifyWorkspaceRestoreFailure(caughtError)).toBe("restore_lock_timeout");
    });

    it.skipIf(process.platform === "win32")(
      "serializes two concurrent writers that address one target through different aliases",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        let active = false;
        let overlapCount = 0;
        let completedCount = 0;
        const runWriter = (dir: string) =>
          withDirectoryMergeLock(dir, async () => {
            if (active) overlapCount += 1;
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            active = false;
            completedCount += 1;
          });

        await Promise.all([runWriter(targetDir), runWriter(aliasDir)]);

        expect(overlapCount).toBe(0);
        expect(completedCount).toBe(2);
      },
    );
  });

  describe("caller-provided env for the lock root", () => {
    // These tests never touch `process.env`. They prove `withDirectoryMergeLock`
    // resolves the lock root from a caller's own `env` object — the shape every
    // environment-parameterized Codex credential call site holds — instead of
    // always reading `process.env`.

    it("two callers that pass the same env with a temporary PAPERCLIP_HOME take the same lock under that home", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome, PAPERCLIP_INSTANCE_ID: "test-instance" };

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      const lockRootDir = path.join(explicitHome, "instances", "test-instance", "locks", "directory-merge");

      let lockNameFirstCaller = "";
      await withDirectoryMergeLock(
        targetDir,
        async () => {
          const entries = await readdir(lockRootDir);
          lockNameFirstCaller = entries[0] ?? "";
        },
        env,
      );

      let lockNameSecondCaller = "";
      await withDirectoryMergeLock(
        targetDir,
        async () => {
          const entries = await readdir(lockRootDir);
          lockNameSecondCaller = entries[0] ?? "";
        },
        env,
      );

      expect(lockNameFirstCaller).not.toBe("");
      expect(lockNameSecondCaller).toBe(lockNameFirstCaller);
      expect(lockRootDir.startsWith(explicitHome + path.sep)).toBe(true);
    });

    it("does not write a lock entry under process.env.PAPERCLIP_HOME when the caller passes its own env", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome, PAPERCLIP_INSTANCE_ID: "test-instance" };

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");

      // Resolved with no `env` argument, so it reads `process.env` exactly the way
      // the real instance root does — unaffected by the explicit `env` above.
      const realInstanceRoot = resolvePaperclipInstanceRootForAdapter();
      const realLockPath = path.join(realInstanceRoot, "locks", "directory-merge", `${lockKey}.lock`);

      await withDirectoryMergeLock(targetDir, async () => undefined, env);

      await expect(lstat(realLockPath)).rejects.toThrow();

      const explicitLockRootDir = path.join(explicitHome, "instances", "test-instance", "locks", "directory-merge");
      await expect(stat(explicitLockRootDir)).resolves.toBeTruthy();
    });

    it("resolves the lock root under the default instance id when the caller env sets PAPERCLIP_HOME but not PAPERCLIP_INSTANCE_ID, ignoring process.env.PAPERCLIP_INSTANCE_ID", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const explicitHome = path.join(rootDir, "explicit-home");
      const env: NodeJS.ProcessEnv = { PAPERCLIP_HOME: explicitHome };

      const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_INSTANCE_ID = "wrong-instance";
      try {
        const targetDir = path.join(rootDir, "target");
        await mkdir(targetDir, { recursive: true });

        // The independent, no-caller-env resolution of "PAPERCLIP_HOME set,
        // PAPERCLIP_INSTANCE_ID unset" — the expected default instance id.
        const expectedInstanceRoot = resolvePaperclipInstanceRootForAdapter({ homeDir: explicitHome, env: {} });
        const expectedLockRootDir = path.join(expectedInstanceRoot, "locks", "directory-merge");
        const wrongInstanceLockRootDir = path.join(explicitHome, "instances", "wrong-instance", "locks", "directory-merge");

        await withDirectoryMergeLock(targetDir, async () => undefined, env);

        await expect(stat(expectedLockRootDir)).resolves.toBeTruthy();
        await expect(stat(wrongInstanceLockRootDir)).rejects.toThrow();
      } finally {
        if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
        else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      }
    });

    it("does not read process.env.PAPERCLIP_HOME when the caller env sets neither variable", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const fakeProcessHome = path.join(rootDir, "process-home");
      const fallbackOsHome = path.join(rootDir, "os-home");
      await mkdir(fallbackOsHome, { recursive: true });

      const previousHome = process.env.PAPERCLIP_HOME;
      process.env.PAPERCLIP_HOME = fakeProcessHome;
      // Stand in for the real host home directory, so the "no env at all"
      // fallback lands under a temp dir instead of the real ~/.paperclip.
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fallbackOsHome);
      try {
        const targetDir = path.join(rootDir, "target");
        await mkdir(targetDir, { recursive: true });

        // The independent, no-caller-env resolution of "neither variable set" —
        // the expected fallback root under the mocked home directory.
        const expectedInstanceRoot = resolvePaperclipInstanceRootForAdapter({ env: {} });
        const expectedLockRootDir = path.join(expectedInstanceRoot, "locks", "directory-merge");

        await withDirectoryMergeLock(targetDir, async () => undefined, {});

        await expect(stat(fakeProcessHome)).rejects.toThrow();
        await expect(stat(expectedLockRootDir)).resolves.toBeTruthy();
      } finally {
        homedirSpy.mockRestore();
        if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
        else process.env.PAPERCLIP_HOME = previousHome;
      }
    });
  });
});

describe("mergeChangedFilesWithBaseline", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeRoot(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  async function writeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
  }

  async function copyDir(source: string, target: string): Promise<void> {
    await fsPromises.cp(source, target, { recursive: true });
  }

  type TreeEntry = { kind: "file"; content: string; exec: boolean } | { kind: "symlink"; target: string };

  // Files and symlinks only: empty directories are compared separately
  // because the changed-files merge deliberately leaves them in place.
  async function readTree(root: string): Promise<Map<string, TreeEntry>> {
    const out = new Map<string, TreeEntry>();
    const walk = async (relative: string): Promise<void> => {
      const current = relative ? path.join(root, relative) : root;
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const next = relative ? path.posix.join(relative, entry.name) : entry.name;
        const full = path.join(root, next);
        if (entry.isDirectory()) {
          await walk(next);
          continue;
        }
        if (entry.isSymbolicLink()) {
          out.set(next, { kind: "symlink", target: await fsPromises.readlink(full) });
          continue;
        }
        if (entry.isFile()) {
          const stats = await lstat(full);
          out.set(next, {
            kind: "file",
            content: await readFile(full, "utf8"),
            exec: (stats.mode & 0o111) !== 0,
          });
        }
      }
    };
    await walk("");
    return out;
  }

  async function listEmptyDirs(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const current = relative ? path.join(root, relative) : root;
      const entries = await readdir(current, { withFileTypes: true });
      if (relative && entries.length === 0) out.push(relative);
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(relative ? path.posix.join(relative, entry.name) : entry.name);
      }
    };
    await walk("");
    return out.sort();
  }

  it("matches the full merge across the file-state matrix, except pruned empty dirs", async () => {
    const root = await makeRoot("paperclip-changed-merge-");
    const seedDir = path.join(root, "seed");
    await writeTree(seedDir, {
      "keep.txt": "unchanged\n",
      "edit-remote.txt": "baseline\n",
      "edit-both.txt": "baseline\n",
      "delete-quiescent.txt": "gone remotely\n",
      "delete-edited.txt": "gone remotely\n",
      "old-name.txt": "renamed remotely\n",
      "mode.sh": "echo baseline\n",
      "sub/nested.txt": "nested\n",
      "fulldir/file.txt": "dir deleted remotely\n",
      "emptyme/file.txt": "dir emptied remotely\n",
      "scratch/skip.txt": "local scratch\n",
    });
    await chmod(path.join(seedDir, "mode.sh"), 0o644);
    await symlink("keep.txt", path.join(seedDir, "link.txt"));

    // The full remote tree: every remote change applied.
    const remoteDir = path.join(root, "remote");
    await copyDir(seedDir, remoteDir);
    await writeFile(path.join(remoteDir, "edit-remote.txt"), "remote\n");
    await writeFile(path.join(remoteDir, "edit-both.txt"), "remote\n");
    await rm(path.join(remoteDir, "delete-quiescent.txt"));
    await rm(path.join(remoteDir, "delete-edited.txt"));
    await rm(path.join(remoteDir, "old-name.txt"));
    await writeFile(path.join(remoteDir, "new-name.txt"), "renamed remotely\n");
    await writeFile(path.join(remoteDir, "added.txt"), "added remotely\n");
    await writeTree(remoteDir, { "sub2/new.txt": "new nested\n" });
    await chmod(path.join(remoteDir, "mode.sh"), 0o755);
    await rm(path.join(remoteDir, "link.txt"));
    await symlink("edit-remote.txt", path.join(remoteDir, "link.txt"));
    await writeFile(path.join(remoteDir, "scratch/skip.txt"), "remote scratch\n");
    await rm(path.join(remoteDir, "fulldir"), { recursive: true });
    await rm(path.join(remoteDir, "emptyme/file.txt"));

    // The partial staging tree: ONLY the remotely-changed files, as the
    // changed-files transfer would deliver them (plus their parent dirs).
    const stagingDir = path.join(root, "staging");
    await writeTree(stagingDir, {
      "edit-remote.txt": "remote\n",
      "edit-both.txt": "remote\n",
      "new-name.txt": "renamed remotely\n",
      "added.txt": "added remotely\n",
      "sub2/new.txt": "new nested\n",
      "mode.sh": "echo baseline\n",
    });
    await chmod(path.join(stagingDir, "mode.sh"), 0o755);
    await symlink("edit-remote.txt", path.join(stagingDir, "link.txt"));
    const deletedPaths = [
      "delete-quiescent.txt",
      "delete-edited.txt",
      "old-name.txt",
      "fulldir/file.txt",
      "emptyme/file.txt",
    ];

    const baseline = await captureDirectorySnapshot(seedDir, { exclude: ["scratch", ".git"] });

    // The local target both merges start from: seed plus concurrent edits.
    const targetSeedDir = path.join(root, "target-seed");
    await copyDir(seedDir, targetSeedDir);
    await writeFile(path.join(targetSeedDir, "edit-both.txt"), "local\n");
    await writeFile(path.join(targetSeedDir, "delete-edited.txt"), "local edit\n");
    await writeFile(path.join(targetSeedDir, "local-only.txt"), "local only\n");

    const fullTarget = path.join(root, "full-target");
    await copyDir(targetSeedDir, fullTarget);
    const fullHooks: string[] = [];
    await mergeDirectoryWithBaseline({
      baseline,
      sourceDir: remoteDir,
      targetDir: fullTarget,
      beforeApply: async () => void fullHooks.push("before"),
      afterApply: async () => void fullHooks.push("after"),
    });

    const changedTarget = path.join(root, "changed-target");
    await copyDir(targetSeedDir, changedTarget);
    const changedHooks: string[] = [];
    let beforeSawBaselineContent = false;
    await mergeChangedFilesWithBaseline({
      baseline,
      sourceDir: stagingDir,
      deletedPaths,
      targetDir: changedTarget,
      beforeApply: async () => {
        changedHooks.push("before");
        beforeSawBaselineContent =
          (await readFile(path.join(changedTarget, "edit-remote.txt"), "utf8")) === "baseline\n";
      },
      afterApply: async () => void changedHooks.push("after"),
    });

    expect(fullHooks).toEqual(["before", "after"]);
    expect(changedHooks).toEqual(["before", "after"]);
    expect(beforeSawBaselineContent).toBe(true);

    // Spot-check the matrix outcomes on the changed-files target.
    await expect(readFile(path.join(changedTarget, "edit-remote.txt"), "utf8")).resolves.toBe("remote\n");
    await expect(readFile(path.join(changedTarget, "edit-both.txt"), "utf8")).resolves.toBe("remote\n");
    await expect(readFile(path.join(changedTarget, "delete-edited.txt"), "utf8")).resolves.toBe("local edit\n");
    await expect(readFile(path.join(changedTarget, "local-only.txt"), "utf8")).resolves.toBe("local only\n");
    await expect(readFile(path.join(changedTarget, "new-name.txt"), "utf8")).resolves.toBe("renamed remotely\n");
    await expect(readFile(path.join(changedTarget, "scratch/skip.txt"), "utf8")).resolves.toBe("local scratch\n");
    expect(await lstat(path.join(changedTarget, "delete-quiescent.txt")).then(() => true, () => false)).toBe(false);
    expect(await lstat(path.join(changedTarget, "old-name.txt")).then(() => true, () => false)).toBe(false);

    // Full differential equality on files and symlinks.
    const fullTree = await readTree(fullTarget);
    const changedTree = await readTree(changedTarget);
    expect([...changedTree.entries()].sort()).toEqual([...fullTree.entries()].sort());

    // The one documented divergence: the full merge prunes remotely-deleted
    // directories, while the changed-files merge leaves them as empty dirs
    // (porcelain cannot distinguish "deleted" from "emptied", and keeping an
    // empty dir can never break a consumer that recreates it on demand).
    expect(await listEmptyDirs(fullTarget)).toEqual(["emptyme"]);
    expect(await listEmptyDirs(changedTarget)).toEqual(["emptyme", "fulldir"]);
  });

  it("runs hooks but leaves the target untouched when nothing changed", async () => {
    const root = await makeRoot("paperclip-changed-merge-clean-");
    const seedDir = path.join(root, "seed");
    await writeTree(seedDir, { "keep.txt": "unchanged\n" });
    const baseline = await captureDirectorySnapshot(seedDir, { exclude: [] });
    const stagingDir = path.join(root, "staging");
    await mkdir(stagingDir, { recursive: true });
    const targetDir = path.join(root, "target");
    await copyDir(seedDir, targetDir);
    const hooks: string[] = [];

    await mergeChangedFilesWithBaseline({
      baseline,
      sourceDir: stagingDir,
      deletedPaths: [],
      targetDir,
      beforeApply: async () => void hooks.push("before"),
      afterApply: async () => void hooks.push("after"),
    });

    expect(hooks).toEqual(["before", "after"]);
    await expect(readFile(path.join(targetDir, "keep.txt"), "utf8")).resolves.toBe("unchanged\n");
  });

  it("rejects a staged file that would replace an excluded path's ancestor", async () => {
    const root = await makeRoot("paperclip-changed-merge-unsafe-");
    const seedDir = path.join(root, "seed");
    await writeTree(seedDir, { "nested/keep.txt": "baseline\n" });
    // The baseline excludes a literal descendant; the remote replaced its
    // ancestor with a file. The full merge rejects this archive; so must we.
    const baseline = await captureDirectorySnapshot(seedDir, { exclude: ["nested/keep.txt"] });
    const stagingDir = path.join(root, "staging");
    await writeTree(stagingDir, { nested: "ancestor replaced by file\n" });
    const targetDir = path.join(root, "target");
    await copyDir(seedDir, targetDir);

    await expect(
      mergeChangedFilesWithBaseline({
        baseline,
        sourceDir: stagingDir,
        deletedPaths: [],
        targetDir,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" });
    await expect(readFile(path.join(targetDir, "nested/keep.txt"), "utf8")).resolves.toBe("baseline\n");
  });

  it("ignores deletes for paths outside the baseline and type-changed targets", async () => {
    const root = await makeRoot("paperclip-changed-merge-deletes-");
    const seedDir = path.join(root, "seed");
    await writeTree(seedDir, { "file.txt": "baseline\n", "other.txt": "baseline\n" });
    const baseline = await captureDirectorySnapshot(seedDir, { exclude: [] });
    const stagingDir = path.join(root, "staging");
    await mkdir(stagingDir, { recursive: true });
    const targetDir = path.join(root, "target");
    await copyDir(seedDir, targetDir);
    // The target replaced a baseline file with a directory: not a baseline
    // match, so the remote delete must not remove it.
    await rm(path.join(targetDir, "other.txt"));
    await mkdir(path.join(targetDir, "other.txt"), { recursive: true });
    await writeFile(path.join(targetDir, "other.txt/inner.txt"), "local\n");

    await mergeChangedFilesWithBaseline({
      baseline,
      sourceDir: stagingDir,
      deletedPaths: ["file.txt", "never-in-baseline.txt", "other.txt"],
      targetDir,
    });

    expect(await lstat(path.join(targetDir, "file.txt")).then(() => true, () => false)).toBe(false);
    await expect(readFile(path.join(targetDir, "other.txt/inner.txt"), "utf8")).resolves.toBe("local\n");
  });

  it("skips an explicit delete whose ancestor became a symlink", async () => {
    const root = await makeRoot("paperclip-changed-merge-symlink-");
    const seedDir = path.join(root, "seed");
    await writeTree(seedDir, { "d/f.txt": "gone remotely\n", "keep.txt": "keep\n" });
    const baseline = await captureDirectorySnapshot(seedDir, { exclude: [] });
    const targetDir = path.join(root, "target");
    await copyDir(seedDir, targetDir);
    // Between baseline capture and restore, d/ is replaced by a symlink to a
    // second tree whose f.txt matches the baseline byte-for-byte: reading the
    // leaf through the link looks like a baseline match, but removing it
    // would delete a file outside the target. The full merge never descends
    // through the link, so the partial merge must not delete through it
    // either: the delete is skipped and the outside file survives.
    const outsideDir = path.join(root, "outside");
    await writeTree(outsideDir, { "f.txt": "gone remotely\n" });
    await rm(path.join(targetDir, "d"), { recursive: true });
    await symlink(outsideDir, path.join(targetDir, "d"));
    const stagingDir = path.join(root, "staging");
    await mkdir(stagingDir, { recursive: true });

    await mergeChangedFilesWithBaseline({
      baseline,
      sourceDir: stagingDir,
      deletedPaths: ["d/f.txt"],
      targetDir,
    });

    await expect(readFile(path.join(outsideDir, "f.txt"), "utf8")).resolves.toBe("gone remotely\n");
    expect((await lstat(path.join(targetDir, "d"))).isSymbolicLink()).toBe(true);
  });
});
