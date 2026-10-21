import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RotatingFileSink } from "../middleware/rotating-file-sink.js";

const dirs: string[] = [];
const sinks: RotatingFileSink[] = [];

afterEach(() => {
  while (sinks.length > 0) sinks.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rotating-sink-test-"));
  dirs.push(dir);
  return dir;
}

function open(
  dir: string,
  opts: { maxBytes?: number; maxFiles?: number; filename?: string } = {},
): RotatingFileSink {
  const sink = new RotatingFileSink({
    dir,
    filename: opts.filename ?? "server.log",
    maxBytes: opts.maxBytes ?? 1024,
    maxFiles: opts.maxFiles ?? 3,
  });
  sinks.push(sink);
  return sink;
}

describe("RotatingFileSink", () => {
  it("appends lines to the live file", () => {
    const dir = tempDir();
    const sink = open(dir);
    sink.write("one\n");
    sink.write("two\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("one\ntwo\n");
  });

  it("creates a missing directory tree", () => {
    const dir = path.join(tempDir(), "nested", "logs");
    const sink = open(dir);
    sink.write("hello\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("hello\n");
  });

  it("appends to an existing file instead of truncating (container recreate case)", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "server.log"), "prior-container-line\n");
    const sink = open(dir, { maxBytes: 1024 });
    sink.write("new-container-line\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe(
      "prior-container-line\nnew-container-line\n",
    );
  });

  it("rotates by size, keeping newest lines in the live file", () => {
    const dir = tempDir();
    const sink = open(dir, { maxBytes: 10, maxFiles: 3 });
    sink.write("aaaa\n"); // 5 bytes, live
    sink.write("bbbb\n"); // 10 bytes total, still live (would exceed only if > max)
    sink.write("cccc\n"); // 15 > 10 -> rotate: live moves to .1
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("cccc\n");
    expect(readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("aaaa\nbbbb\n");
  });

  it("shifts generations and drops the oldest beyond maxFiles", () => {
    const dir = tempDir();
    const sink = open(dir, { maxBytes: 5, maxFiles: 3 });
    sink.write("l1\n"); // live (3 bytes)
    sink.write("l2\n"); // 6 > 5 -> rotate (.1=l1)
    sink.write("l3\n"); // live=l2(3); 3+3>5 -> rotate (.2=l1, .1=l2)
    sink.write("l4\n"); // rotate again (.2=l2, .1=l3, live=l4)
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("l4\n");
    expect(readFileSync(path.join(dir, "server.log.1"), "utf8")).toBe("l3\n");
    expect(readFileSync(path.join(dir, "server.log.2"), "utf8")).toBe("l2\n");
    expect(readdirSync(dir).sort()).toEqual(["server.log", "server.log.1", "server.log.2"]);
  });

  it("writes an oversized single line without rotating an empty file in a loop", () => {
    const dir = tempDir();
    const sink = open(dir, { maxBytes: 4, maxFiles: 3 });
    sink.write("way-too-long\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("way-too-long\n");
    expect(readdirSync(dir)).toEqual(["server.log"]);
  });

  it("drops writes after close instead of throwing", () => {
    const dir = tempDir();
    const sink = open(dir);
    sink.write("kept\n");
    sink.close();
    sink.write("dropped\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("kept\n");
  });

  it("reports write failures via onError instead of throwing", () => {
    const dir = tempDir();
    const seen: Array<{ err: unknown; context: string }> = [];
    const sink = new RotatingFileSink({
      dir,
      filename: "server.log",
      maxBytes: 1024,
      maxFiles: 3,
      onError: (err, context) => seen.push({ err, context }),
    });
    sinks.push(sink);
    const failure = new Error("EIO: simulated disk failure");
    const spy = vi.spyOn(fs, "writeSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => sink.write("lost\n")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.err).toBe(failure);
    expect(seen[0]?.context).toContain("write");
    // The sink keeps serving later writes after a transient failure.
    sink.write("kept\n");
    expect(readFileSync(path.join(dir, "server.log"), "utf8")).toBe("kept\n");
  });

  it("throws when the directory cannot be created (owner falls back to stdout-only)", () => {
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    expect(
      () =>
        new RotatingFileSink({
          dir: path.join(blocker, "logs"),
          filename: "server.log",
          maxBytes: 1024,
          maxFiles: 3,
        }),
    ).toThrow();
  });
});
