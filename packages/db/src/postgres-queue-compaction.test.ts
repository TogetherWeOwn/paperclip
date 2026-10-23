import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type DriverQueue<T> = {
  readonly length: number;
  push: (value: T) => T;
  shift: () => T;
  remove: (value: T) => T | null;
};
type QueueFactory = <T>(initial?: T[]) => DriverQueue<T>;

const nodeRequire = createRequire(import.meta.url);
const cjsEntry = nodeRequire.resolve("postgres");
const cjsQueuePath = path.join(path.dirname(cjsEntry), "queue.js");
const esmQueuePath = path.resolve(path.dirname(cjsEntry), "../../src/queue.js");

async function loadQueue(format: "esm" | "cjs"): Promise<QueueFactory> {
  if (format === "cjs") return nodeRequire(cjsQueuePath) as QueueFactory;
  return (await import(pathToFileURL(esmQueuePath).href)).default as QueueFactory;
}

describe("postgres.js queue compaction", () => {
  for (const format of ["esm", "cjs"] as const) {
    it(`${format}: keeps storage bounded when the queue never becomes empty`, async () => {
      const Queue = await loadQueue(format);
      let largest = 0;
      class TrackedArray<T> extends Array<T> {
        override push(...items: T[]) {
          const length = super.push(...items);
          largest = Math.max(largest, length);
          return length;
        }
      }
      const queue = Queue<string>(new TrackedArray<string>());
      queue.push("a");
      queue.push("b");
      queue.push("c");
      for (let i = 0; i < 10_000; i++) queue.push(queue.shift());

      const observed: Array<string | number | null> = [
        queue.length,
        queue.remove("x"),
        queue.shift(),
        queue.remove("a"),
        queue.length,
        queue.shift(),
        queue.length,
      ];
      queue.push("d");
      queue.push("e");
      observed.push(queue.remove("d"), queue.shift());

      expect(observed).toEqual([3, null, "b", "a", 1, "c", 0, "d", "e"]);
      expect(largest).toBeGreaterThan(0);
      expect(largest).toBeLessThan(1_000);
    });

    it(`${format}: keeps first-in, first-out order across compactions`, async () => {
      const Queue = await loadQueue(format);
      const queue = Queue<number>();
      const received: number[] = [];
      let next = 0;
      for (let i = 0; i < 5; i++) queue.push(next++);
      for (let round = 0; round < 2_000; round++) {
        received.push(queue.shift());
        queue.push(next++);
        if (round % 7 === 0) queue.push(next++);
        if (round % 11 === 0) received.push(queue.shift());
      }
      while (queue.length > 0) received.push(queue.shift());
      expect(received).toEqual(Array.from({ length: next }, (_, index) => index));
    });
  }
});
