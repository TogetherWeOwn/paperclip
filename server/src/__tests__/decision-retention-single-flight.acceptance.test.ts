import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import * as retentionExports from "../services/decision-retention.js";

// Exercise the scheduler's real closure without importing index.ts (which boots
// an application database and services). Include lexical state it references,
// rather than reimplementing the sweep or asserting on source text.
type SyntaxNode = {
  type: string;
  start: number;
  end: number;
  name?: string;
  id?: SyntaxNode;
  declarations?: SyntaxNode[];
  body?: SyntaxNode[];
};

async function loadScheduledSweep(dependencies: Record<string, unknown>): Promise<() => Promise<unknown>> {
  // Use the parser shipped with Vitest's Vite, not the removed TypeScript 7
  // compiler API. No extra dependency or package-manifest change is needed.
  const require = createRequire(import.meta.url);
  const viteRequire = createRequire(require.resolve("vitest/package.json"));
  const { parseSync } = await import(viteRequire.resolve("vite"));
  const text = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const source = parseSync("index.ts", text).program as SyntaxNode;
  function children(node: SyntaxNode): SyntaxNode[] {
    return Object.values(node).flatMap((value) => {
      const values = Array.isArray(value) ? value : [value];
      return values.filter((child): child is SyntaxNode => child !== null && typeof child === "object" && "type" in child);
    });
  }
  let target: SyntaxNode | undefined;
  let scope: SyntaxNode | undefined;
  function find(node: SyntaxNode, parent?: SyntaxNode) {
    if (node.type === "VariableDeclaration" && node.declarations?.some(
      (declaration) => declaration.id?.name === "runRetentionSweep",
    )) { target = node; scope = parent; }
    for (const child of children(node)) find(child, node);
  }
  find(source);
  if (!target || scope?.type !== "BlockStatement") throw new Error("Cannot locate the retention scheduler closure");
  const bindings = { ...retentionExports, ...dependencies };
  const siblings = new Map<string, SyntaxNode>();
  for (const statement of scope.body ?? []) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations ?? []) {
        if (declaration.id?.name) siblings.set(declaration.id.name, statement);
      }
    } else if (statement.type === "FunctionDeclaration" && statement.id?.name) {
      siblings.set(statement.id.name, statement);
    }
  }
  const included = new Set<SyntaxNode>();
  function include(statement: SyntaxNode) {
    if (included.has(statement)) return;
    included.add(statement);
    function visit(node: SyntaxNode) {
      if (node.type === "Identifier" && node.name && !Object.hasOwn(bindings, node.name)) {
        const dependency = siblings.get(node.name);
        if (dependency) include(dependency);
      }
      for (const child of children(node)) visit(child);
    }
    visit(statement);
  }
  include(target);
  const code = [...included].sort((a, b) => a.start - b.start).map((statement) => text.slice(statement.start, statement.end)).join("\n");
  const javascript = stripTypeScriptTypes(`${code}\n;globalThis.sweep = runRetentionSweep;`);
  const context = { ...bindings, sweep: undefined as (() => Promise<unknown>) | undefined };
  runInNewContext(javascript, context, { timeout: 1_000 });
  return context.sweep!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup() {
  const companies = [{ id: "company-a" }, { id: "company-b" }];
  const reads: string[] = [];
  const archives: string[] = [];
  const notifications: string[] = [];
  const list = vi.fn(async (companyId: string, options: unknown) => {
    reads.push(companyId);
    expect(options).toMatchObject({ includeDismissed: true, all: true, allowUnscopedAll: true });
    return { items: [{ companyId, sourceKind: "review", subject: { id: `${companyId}-review` } }] };
  });
  const autoArchive = vi.fn(async ({ companyId }: { companyId: string }) => {
    archives.push(companyId);
    return 1;
  });
  const deliverNotifications = vi.fn(async () => {
    notifications.push("delivered");
    return { notifiedAgents: 2, delivered: 2 };
  });
  const db = {
    select: () => ({ from: () => ({ where: async () => companies }) }),
  };
  const sweep = await loadScheduledSweep({
    db, companies: {}, eq: () => undefined,
    attentionService: () => ({ list }),
    retentionExecutor: { autoArchive, deliverNotifications },
  });
  return { sweep, list, autoArchive, deliverNotifications, reads, archives, notifications };
}

// Flush promise continuations, not wall-clock time: a deliberately deferred
// dependency stays pending regardless of host load.
async function flush() {
  for (let step = 0; step < 30; step += 1) await Promise.resolve();
}

describe("scheduled decision retention single-flight acceptance", () => {
  it.each(["feed", "archive", "notifications"] as const)(
    "does not start a second sweep while %s work is pending",
    async (phase) => {
      const state = await setup();
      const gate = deferred<void>();
      if (phase === "feed") {
        const original = state.list.getMockImplementation()!;
        state.list.mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
      } else if (phase === "archive") {
        const original = state.autoArchive.getMockImplementation()!;
        state.autoArchive.mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
      } else {
        const original = state.deliverNotifications.getMockImplementation()!;
        state.deliverNotifications.mockImplementationOnce(async () => { await gate.promise; return original(); });
      }
      const first = state.sweep();
      await flush();
      const readsBeforeSecondTick = state.list.mock.calls.length;
      const second = state.sweep();
      try {
        await flush();
        expect(state.list.mock.calls.length, "a pending sweep must not rebuild another feed").toBe(readsBeforeSecondTick);
      } finally {
        gate.resolve();
        await Promise.allSettled([first, second]);
      }
      expect(state.reads).toEqual(["company-a", "company-b"]);
      expect(state.archives).toEqual(["company-a", "company-b"]);
      expect(state.notifications).toEqual(["delivered"]);
      await expect(state.sweep()).resolves.toEqual({ archived: 2, notifiedAgents: 2, delivered: 2 });
      expect(state.reads).toEqual(["company-a", "company-b", "company-a", "company-b"]);
    },
  );

  it.each(["feed", "archive", "notifications"] as const)(
    "clears in-flight state after a rejected %s operation and retries all companies",
    async (phase) => {
      const state = await setup();
      const failure = new Error(`test ${phase} failure`);
      const gate = deferred<never>();
      if (phase === "feed") state.list.mockImplementationOnce(() => gate.promise);
      else if (phase === "archive") state.autoArchive.mockImplementationOnce(() => gate.promise);
      else state.deliverNotifications.mockImplementationOnce(() => gate.promise);
      const first = state.sweep();
      const observed = first.catch((error: unknown) => error);
      await flush();
      gate.reject(failure);
      expect(await observed).toBe(failure);
      const readsAfterFailure = state.reads.length;
      await expect(state.sweep()).resolves.toEqual({ archived: 2, notifiedAgents: 2, delivered: 2 });
      expect(state.reads.slice(readsAfterFailure)).toEqual(["company-a", "company-b"]);
    },
  );
});
