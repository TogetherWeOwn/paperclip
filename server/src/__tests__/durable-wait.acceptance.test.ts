import { describe, expect, it, vi } from "vitest";
import { evaluateDurableWait } from "../modules/run-dispatch/domain/durable-wait.js";
import {
  AGENT, HOUR, NOW, OTHER_AGENT, OTHER_COMPANY, OTHER_ISSUE, waitFacts,
  type DurableWaitDecision, type DurableWaitFacts,
} from "./fixtures/durable-wait-contract.js";

const evaluate: (facts: DurableWaitFacts, now: number) => DurableWaitDecision = evaluateDurableWait;

function check(facts: DurableWaitFacts, valid: boolean, suppressibleFallback = false, now = NOW) {
  const result = evaluate(facts, now);
  expect(result).toMatchObject({ valid, suppressibleFallback });
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim().length).toBeGreaterThan(0);
  expect(result.suppressibleFallback && !result.valid).toBe(false);
}

// Runtime corruption/unknown facts deliberately bypass the compile-time contract.
function put(facts: DurableWaitFacts, path: string, value: unknown) {
  const parts = path.split(".");
  let target = facts as unknown as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
}

const rejected: Array<[string, string, unknown]> = [
  ["flag off", "mode", "off"], ["unknown mode", "mode", "future-mode"],
  ["missing coverage", "coverage", null], ["failed observation", "coverage.observationStatus", "error"],
  ["unknown observation", "coverage.observationStatus", "unknown"],
  ["expired coverage", "coverage.expiresAt", NOW - 1], ["coverage expiry equality", "coverage.expiresAt", NOW],
  ["freshness equality", "coverage.observedAt", NOW - 2 * HOUR],
  ["stale observation", "coverage.observedAt", NOW - 2 * HOUR - 1],
  ["future observation", "coverage.observedAt", NOW + 1],
  ["cross-company coverage", "coverage.companyId", OTHER_COMPANY],
  ["cross-issue coverage", "coverage.issueId", OTHER_ISSUE],
  ["agent writer is not authenticated coverage authority", "coverage.registeredByActor", { type: "agent", id: AGENT }],
  ["unknown coverage authority", "coverage.registeredByActor", { type: "unknown", id: "actor" }],
  ["unknown source", "coverage.sourceKind", "unknown"],
  ["empty current revision", "coverage.eventRevision", ""], ["empty armed revision", "coverage.armedRevision", ""],
  ["unresolved actionable event", "coverage.unresolvedActionableEventAt", NOW - 1],
  ["future actionable event is not null", "coverage.unresolvedActionableEventAt", NOW + 1],
  ["changed assignee", "issue.assigneeAgentId", OTHER_AGENT], ["no assignee", "issue.assigneeAgentId", null],
  ["user assignment", "issue.assigneeUserId", "board-user"],
  ["changed eligible status", "issue.status", "in_progress"],
  ...["done", "cancelled", "todo", "backlog", "blocked", "unknown"].map((s): [string, string, unknown] => [`status ${s}`, "issue.status", s]),
  ["armed assignee changed", "coverage.armedAssigneeAgentId", OTHER_AGENT],
  ["armed status changed", "coverage.armedStatus", "in_progress"],
  ["monitor service mismatch", "monitor.serviceName", "different-service"],
  ["monitor reference mismatch", "monitor.externalRef", "https://github.com/example/project/pull/43"],
  ["unknown monitor kind", "monitor.kind", "unknown"],
  ["quota monitor", "monitor.serviceName", "AI provider quota"],
  ["future monitor past expiry", "monitor.nextCheckAt", NOW + 12 * HOUR + 1],
  ["timeout equality", "budget.timeoutAt", NOW], ["expired timeout", "budget.timeoutAt", NOW - 1],
  ["attempt equality", "budget.attemptCount", 3], ["exhausted attempts", "budget.attemptCount", 4],
  ["negative attempts", "budget.attemptCount", -1], ["fractional attempts", "budget.attemptCount", 0.5],
  ["zero max attempts", "budget.maxAttempts", 0], ["negative max attempts", "budget.maxAttempts", -1],
  ["fractional max attempts", "budget.maxAttempts", 1.5],
  ["zero freshness", "freshnessMs", 0], ["negative freshness", "freshnessMs", -1],
  ...["activeRun", "queuedWake", "queuedRun", "scheduledRetry", "pendingAgentInteraction", "pendingAgentApproval"].map((key): [string, string, unknown] => [`competing ${key}`, `competing.${key}`, true]),
];

const requiredPaths = [
  "mode", "issue", "issue.id", "issue.companyId", "issue.status", "issue.assigneeAgentId", "issue.assigneeUserId",
  "coverage", "coverage.issueId", "coverage.companyId", "coverage.serviceName", "coverage.externalRef",
  "coverage.sourceKind", "coverage.registeredByActor", "coverage.registeredByActor.type", "coverage.registeredByActor.id", "coverage.eventRevision", "coverage.armedRevision",
  "coverage.observationStatus", "coverage.observedAt", "coverage.expiresAt", "coverage.armedAssigneeAgentId",
  "coverage.armedStatus", "coverage.unresolvedActionableEventAt", "monitor", "monitor.kind", "monitor.serviceName",
  "monitor.externalRef", "monitor.nextCheckAt", "budget", "budget.attemptCount", "budget.maxAttempts", "budget.timeoutAt",
  "competing", ...Object.keys(waitFacts().competing).map((k) => `competing.${k}`),
];

for (const mode of ["shadow", "enforce"] as const) {
  describe(`durable wait acceptance (${mode})`, () => {
    it.each(["in_progress", "in_review"])("accepts unchanged %s future monitor without making it suppressible", (status) => {
      const facts = waitFacts(); facts.mode = mode; facts.issue.status = status; facts.coverage!.armedStatus = status;
      delete facts.backoffMs;
      check(facts, true);
    });

    it.each([NOW - HOUR, NOW - 1, NOW])("due monitor at %s is eligible only through its bounded successor", (nextCheckAt) => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor!.nextCheckAt = nextCheckAt;
      check(facts, true, true);
    });

    for (const branch of ["future", "due", "coverage-only"] as const) {
      const cases = rejected.filter(([, path]) => branch !== "coverage-only" || !path.startsWith("monitor."));
      it.each(cases)(`${branch} fails open: %s`, (_label, path, value) => {
        const facts = waitFacts(); facts.mode = mode;
        if (branch === "due") facts.monitor!.nextCheckAt = NOW;
        if (branch === "coverage-only") facts.monitor = null;
        put(facts, path, value); check(facts, false);
      });
    }

    it.each(requiredPaths)("does not invent unknown fact %s", (path) => {
      const facts = waitFacts(); facts.mode = mode; put(facts, path, undefined); check(facts, false);
    });

    it.each(["new-head", "new-red", "new-green", "review-findings", "conflict", "merged"])("invalidates coverage on %s revision", (state) => {
      const facts = waitFacts(); facts.mode = mode; facts.coverage!.eventRevision = `head-b:${state}`; check(facts, false);
    });

    it("accepts the last remaining attempt; the next snapshot is exhausted", () => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor!.nextCheckAt = NOW; facts.budget.attemptCount = 2;
      check(facts, true, true); facts.budget.attemptCount += 1; check(facts, false);
    });

    it.each([NOW, NOW - 2 * HOUR + 1])("accepts observation just inside the freshness window at %s", (observedAt) => {
      const facts = waitFacts(); facts.mode = mode; facts.coverage!.observedAt = observedAt; check(facts, true);
    });

    it("uses an explicit custom freshness window, including its equality boundary", () => {
      const facts = waitFacts(); facts.mode = mode; facts.freshnessMs = HOUR + 1; check(facts, true);
      facts.freshnessMs = HOUR; check(facts, false);
    });

    it.each(["coverage", "timeout"])("accepts fallback equal to the future %s hard bound, not beyond it", (bound) => {
      const facts = waitFacts(); facts.mode = mode;
      if (bound === "coverage") facts.coverage!.expiresAt = NOW + HOUR;
      else facts.budget.timeoutAt = NOW + HOUR;
      check(facts, true); facts.monitor!.nextCheckAt += 1; check(facts, false);
    });

    it.each([1, HOUR, 24 * HOUR])("caps due successor delay %s at authenticated bounds", (backoffMs) => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor!.nextCheckAt = NOW;
      facts.backoffMs = backoffMs; facts.budget.timeoutAt = NOW + 1; facts.coverage!.expiresAt = NOW + 2;
      check(facts, true, true);
    });

    it.each([undefined, null, 0, -1, NaN, Infinity, "1000"])("rejects due monitor without finite positive delay %s", (backoff) => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor!.nextCheckAt = NOW; put(facts, "backoffMs", backoff); check(facts, false);
    });

    it("rejects a positive delay whose addition cannot produce a future representable time", () => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor!.nextCheckAt = NOW; facts.backoffMs = Number.MIN_VALUE;
      check(facts, false);
    });

    it("coverage-only is bounded and never suppressible, even with a rescheduling delay", () => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor = null; check(facts, true);
      for (const fallback of [NOW, NOW - 1, NOW + 12 * HOUR + 1, null, undefined, NaN, Infinity]) {
        put(facts, "coverage.fallbackAt", fallback); check(facts, false);
      }
    });

    it("coverage-only requires an explicit finite budget and respects timeout", () => {
      const facts = waitFacts(); facts.mode = mode; facts.monitor = null;
      facts.budget.timeoutAt = NOW + HOUR; check(facts, true);
      facts.coverage!.fallbackAt = NOW + HOUR + 1; check(facts, false);
      facts.coverage!.fallbackAt = NOW + HOUR; put(facts, "budget", undefined); check(facts, false);
    });

    it("cannot rescue a malformed present monitor with a valid coverage-only fallback", () => {
      const facts = waitFacts(); facts.mode = mode; put(facts, "monitor", {}); check(facts, false);
    });

    it("rejects a matched provider-quota monitor rather than merely mismatching service", () => {
      const facts = waitFacts(); facts.mode = mode;
      facts.monitor!.serviceName = facts.coverage!.serviceName = "AI provider quota";
      check(facts, false);
    });
  });
}

describe("pure, deterministic and fail-open", () => {
  it.each([null, undefined, {}, "unknown"])("does not throw or grant a wait for unknown facts %j", (facts) => {
    check(facts as unknown as DurableWaitFacts, false);
  });

  it.each([
    ["coverage.eventRevision", "coverage.armedRevision"],
    ["issue.companyId", "coverage.companyId"],
    ["issue.id", "coverage.issueId"],
    ["issue.assigneeAgentId", "coverage.armedAssigneeAgentId"],
    ["monitor.serviceName", "coverage.serviceName"],
    ["monitor.externalRef", "coverage.externalRef"],
  ])("matching empty or unknown %s/%s is not proof", (left, right) => {
    for (const value of [undefined, null, ""]) {
      const facts = waitFacts(); put(facts, left, value); put(facts, right, value); check(facts, false);
    }
  });

  it.each(["coverage.observedAt", "coverage.expiresAt", "monitor.nextCheckAt", "budget.timeoutAt", "budget.attemptCount", "budget.maxAttempts", "freshnessMs"])("rejects malformed numeric fact %s", (path) => {
    for (const value of [NaN, Infinity, -Infinity, "not-a-time", {}, new Date("invalid")]) {
      const facts = waitFacts(); put(facts, path, value); check(facts, false);
    }
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite evaluation clock %s", (now) => check(waitFacts(), false, false, now));

  it("returns repeatable results without clock reads or input mutation", () => {
    const facts = waitFacts(); const original = structuredClone(facts);
    function freeze(value: object) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); }
    freeze(facts);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("pure predicate read wall clock"); });
    try { expect(evaluate(facts, NOW)).toEqual(evaluate(facts, NOW)); check(facts, true); }
    finally { clock.mockRestore(); }
    expect(facts).toEqual(original);
  });

  it("terminal snapshot wins over a formerly valid frozen snapshot", () => {
    const old = waitFacts(); check(old, true);
    const current = structuredClone(old); current.issue.status = "done"; check(current, false); check(old, true);
  });

  it.each([NOW - 1, NOW, NOW + 1])("off never becomes a durable exemption or suppression at %s", (nextCheckAt) => {
    const facts = waitFacts(); facts.mode = "off"; facts.monitor!.nextCheckAt = nextCheckAt; check(facts, false);
  });
});
