import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  FATAL_EXIT_FLUSH_MS,
  installUncaughtExceptionPolicy,
  type FatalProcess,
} from "../fatal-exception-policy.js";

describe("installUncaughtExceptionPolicy", () => {
  it("logs the error and exits 1 instead of continuing", () => {
    const emitter = new EventEmitter();
    const exit = vi.fn() as unknown as FatalProcess["exit"];
    const log = vi.fn();
    const proc: FatalProcess = {
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      exit,
    };

    installUncaughtExceptionPolicy(proc, log);
    const error = new Error("queue overflow");
    emitter.emit("uncaughtException", error);

    expect(log).toHaveBeenCalledWith(
      "[paperclip] fatal uncaught exception; exiting so the supervisor can restart",
      error,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits only after the flush hook settles", async () => {
    const emitter = new EventEmitter();
    const exit = vi.fn() as unknown as FatalProcess["exit"];
    const proc: FatalProcess = {
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      exit,
    };
    let release: () => void = () => {};
    const beforeExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    installUncaughtExceptionPolicy(proc, vi.fn(), beforeExit);
    emitter.emit("uncaughtException", new Error("queue overflow"));
    await Promise.resolve();

    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits when the flush hook rejects", async () => {
    const emitter = new EventEmitter();
    const exit = vi.fn() as unknown as FatalProcess["exit"];
    const proc: FatalProcess = {
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      exit,
    };

    installUncaughtExceptionPolicy(proc, vi.fn(), () => Promise.reject(new Error("flush failed")));
    emitter.emit("uncaughtException", new Error("queue overflow"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits immediately on a second exception during flush", () => {
    const emitter = new EventEmitter();
    const exit = vi.fn() as unknown as FatalProcess["exit"];
    const proc: FatalProcess = {
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      exit,
    };

    installUncaughtExceptionPolicy(
      proc,
      vi.fn(),
      () => new Promise(() => {}),
    );
    emitter.emit("uncaughtException", new Error("first"));
    expect(exit).not.toHaveBeenCalled();
    emitter.emit("uncaughtException", new Error("second"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits when logging throws", () => {
    const emitter = new EventEmitter();
    const exit = vi.fn() as unknown as FatalProcess["exit"];
    const proc: FatalProcess = {
      on: (event, listener) => {
        emitter.on(event, listener);
      },
      exit,
    };

    installUncaughtExceptionPolicy(proc, () => {
      throw new Error("log failed");
    });
    emitter.emit("uncaughtException", new Error("queue overflow"));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits when the flush hook does not settle within the cap", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const exit = vi.fn() as unknown as FatalProcess["exit"];
      const proc: FatalProcess = {
        on: (event, listener) => {
          emitter.on(event, listener);
        },
        exit,
      };

      installUncaughtExceptionPolicy(proc, vi.fn(), () => new Promise(() => {}));
      emitter.emit("uncaughtException", new Error("queue overflow"));
      await vi.advanceTimersByTimeAsync(FATAL_EXIT_FLUSH_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
