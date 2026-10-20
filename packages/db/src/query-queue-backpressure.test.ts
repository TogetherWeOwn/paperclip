import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

type PatchedQueue = {
  length: number;
  push: (value: unknown) => unknown;
  shift: () => unknown;
};

function patchedQueueHrefs(): { esm: string; cjs: string } {
  // Package exports omit ./package.json. require.resolve("postgres") is the CJS
  // entry (cjs/src/index.js). Production loads the ESM entry, whose queue module
  // is src/queue.js, a different file with its own copy of the patch.
  const cjsEntry = pathToFileURL(createRequire(import.meta.url).resolve("postgres"));
  const cjs = new URL("./queue.js", cjsEntry);
  const esm = new URL("../../src/queue.js", cjsEntry);
  if (!cjs.pathname.endsWith("/cjs/src/queue.js")) {
    throw new Error(`expected the CJS queue module, got ${cjs.pathname}`);
  }
  if (!esm.pathname.endsWith("/src/queue.js") || esm.pathname.includes("/cjs/")) {
    throw new Error(`expected the ESM queue module, got ${esm.pathname}`);
  }
  if (cjs.href === esm.href) {
    throw new Error("expected distinct ESM and CJS queue modules");
  }
  return { esm: esm.href, cjs: cjs.href };
}

async function loadPatchedQueue(href: string): Promise<(initial?: unknown[]) => PatchedQueue> {
  const mod = (await import(href)) as { default: (initial?: unknown[]) => PatchedQueue };
  return mod.default;
}

type ReservationState = "pending" | "resolved" | { rejected: unknown };

async function withStalledReservations(
  build: "esm" | "cjs",
  max: number,
  maxQueue: number,
  check: (fixture: {
    sql: ReturnType<typeof postgres>;
    sockets: Set<net.Socket>;
    states: ReservationState[];
    reserve: () => void;
  }) => Promise<void>,
): Promise<void> {
  // Load the actual, distinct driver entries, not just their queue helpers.
  const entry = new URL("./index.js", patchedQueueHrefs()[build]);
  const { default: driver } = (await import(entry.href)) as { default: typeof postgres };
  const sockets = new Set<net.Socket>();
  let closing = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (closing) socket.destroy();
    // No PostgreSQL handshake response: every admitted reserve stays pending.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the stall server to bind a TCP port");
  }
  const sql = driver({
    host: "127.0.0.1",
    port: address.port,
    max,
    max_queue: maxQueue,
    fetch_types: false,
    connect_timeout: 30,
  } as unknown as postgres.Options<Record<string, never>>);
  const states: ReservationState[] = [];
  const pending: Promise<unknown>[] = [];
  const reserve = () => {
    const index = states.push("pending") - 1;
    pending.push(sql.reserve().then(
      (reserved) => {
        states[index] = "resolved";
        reserved.release();
      },
      (error: unknown) => { states[index] = { rejected: error }; },
    ));
  };
  try {
    await check({ sql, sockets, states, reserve });
  } finally {
    closing = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      sql.end({ timeout: 0 }),
    ]);
    await Promise.all(pending);
  }
}

describe("postgres query queue backpressure", () => {
  it.each(["esm", "cjs"] as const)(
    "%s reserve fills all three cold connections before rejecting a waiter at max_queue:1",
    async (build) => {
      await withStalledReservations(build, 3, 1, async ({ sql, sockets, states, reserve }) => {
        for (let count = 1; count <= 3; count += 1) {
          reserve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect([...states]).toEqual(Array(count).fill("pending"));
          await expect.poll(() => sockets.size, { timeout: 2000 }).toBe(count);
          expect([...states]).toEqual(Array(count).fill("pending"));
        }
        await expect(sql.reserve()).rejects.toMatchObject({ code: "QUERY_QUEUE_FULL" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sockets.size).toBe(3);
        expect([...states]).toEqual(["pending", "pending", "pending"]);
      });
    },
  );

  it.each(["esm", "cjs"] as const)(
    "%s reserve opens the first cold connection with max_queue:0 and rejects only when occupied",
    async (build) => {
      await withStalledReservations(build, 1, 0, async ({ sql, sockets, states, reserve }) => {
        reserve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect([...states]).toEqual(["pending"]);
        await expect.poll(() => sockets.size, { timeout: 2000 }).toBe(1);
        expect([...states]).toEqual(["pending"]);
        await expect(sql.reserve()).rejects.toMatchObject({ code: "QUERY_QUEUE_FULL" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sockets.size).toBe(1);
        expect([...states]).toEqual(["pending"]);
      });
    },
  );
  it("rejects the next waiter with QUERY_QUEUE_FULL when the pending queue is full", async () => {
    const sockets = new Set<net.Socket>();
    let closing = false;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
      });
      // Accept can land after shutdown starts and before close() runs. A live
      // socket keeps server.close() pending until the test timeout.
      if (closing) socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the stall server to bind a TCP port");
    }

    // max_queue is added by the vendored driver patch and is not in the
    // published Options type. The cast goes through unknown because
    // Parameters<typeof postgres> selects the url overload. The peer accepts
    // and never replies, so the first query stays in connect and the next
    // ones wait on the global queue.
    const sql = postgres({
      host: "127.0.0.1",
      port: address.port,
      max: 1,
      max_pipeline: 1,
      max_queue: 2,
      fetch_types: false,
      connect_timeout: 2,
    } as unknown as postgres.Options<Record<string, never>>);
    const hung: Array<Promise<unknown>> = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        hung.push(sql`select ${i}`.catch(() => undefined));
      }
      await expect(sql`select 3`).rejects.toMatchObject({ code: "QUERY_QUEUE_FULL" });
    } finally {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
        // timeout 0 schedules the driver's destroy on the next turn.
        sql.end({ timeout: 0 }).catch(() => undefined),
      ]);
      await Promise.all(hung);
    }
  });

  it("rejects reserve() once the pending queue is full and does not open another connection", async () => {
    const sockets = new Set<net.Socket>();
    let closing = false;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
      });
      if (closing) socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the stall server to bind a TCP port");
    }

    const sql = postgres({
      host: "127.0.0.1",
      port: address.port,
      max: 1,
      max_queue: 1,
      fetch_types: false,
      connect_timeout: 2,
    } as unknown as postgres.Options<Record<string, never>>);
    // The first reserve() pushes before it returns. Do not await it first, or
    // the queue drains and the assertion no longer covers the cap.
    const first = sql.reserve().catch(() => undefined);
    try {
      await expect(sql.reserve()).rejects.toMatchObject({ code: "QUERY_QUEUE_FULL" });
      expect(sockets.size).toBeLessThanOrEqual(1);
    } finally {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
        sql.end({ timeout: 0 }).catch(() => undefined),
      ]);
      await first;
    }
  });

  it("keeps the logical length correct while the queue never fully drains", async () => {
    for (const href of Object.values(patchedQueueHrefs())) {
      const Queue = await loadPatchedQueue(href);
      const queue = Queue();
      queue.push("held");
      for (let i = 0; i < 5000; i += 1) {
        queue.push(i);
        expect(queue.shift()).toBe(i === 0 ? "held" : i - 1);
        expect(queue.length).toBe(1);
      }
      expect(queue.shift()).toBe(4999);
      expect(queue.length).toBe(0);
    }
  });

  it("compacts the backing array so a non-empty queue does not retain shifted holes", () => {
    const hrefs = Object.values(patchedQueueHrefs());
    const script = `
      for (const href of ${JSON.stringify(hrefs)}) {
        const { default: Queue } = await import(href);
        const queue = Queue();
        queue.push(1);
        global.gc();
        const baseline = process.memoryUsage().heapUsed;
        for (let i = 0; i < 2000000; i += 1) {
          queue.push(i);
          queue.shift();
        }
        global.gc();
        const growth = process.memoryUsage().heapUsed - baseline;
        if (queue.length !== 1) {
          console.error(href + " length " + queue.length);
          process.exit(2);
        }
        if (growth > 8 * 1024 * 1024) {
          console.error(href + " growth " + growth);
          process.exit(3);
        }
        console.log(JSON.stringify({ href, length: queue.length, growth }));
      }
    `;
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    expect(child.stderr ?? "").toBe("");
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('"length":1');
  });
});
