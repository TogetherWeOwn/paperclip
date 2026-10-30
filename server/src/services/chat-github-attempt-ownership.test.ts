import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  chatActions, chatGitHubReviews, createDb, getEmbeddedPostgresTestSupport, heartbeatRuns,
  startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attemptFixture, type AttemptFixture } from "./chat-github-attempt-acceptance.test-support.js";
import { githubReviewCheckService } from "./chat-github-checks.js";
import { githubChatReviewService } from "./chat-github-reviews.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { idleWorkSnapshot } from "./task-admission.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("GitHub attempt-bound ownership PostgreSQL behavior", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-attempt-ownership-");
    db = createDb(temporary.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0,
      connectTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function withFixture(test: (f: AttemptFixture) => Promise<void>) {
    const rollback = Symbol("fixture rollback");
    try {
      await db.transaction(async tx => { await test(await attemptFixture(tx as unknown as Db)); throw rollback; });
    } catch (error) { if (error !== rollback) throw error; }
  }
  async function failedDuplicate(f: AttemptFixture) {
    const source = await f.receipt(), execution = await f.run("failed");
    await f.db.update(chatGitHubReviews).set({ runId: execution.id, state: "running" })
      .where(eq(chatGitHubReviews.id, source.review!.id));
    return { source, execution, review: await f.readReview(source.review!.id) };
  }

  it.each(["manual", "automatic"] as const)("keeps delayed A off authorized %s B and settles B's own check", async kind => {
    await withFixture(async f => {
      const a = await f.attempt();
      await f.worker.processPending();
      const aPending = await f.readReview(a.review.id), aId = Number(aPending.checkId);
      expect(f.checks.find(check => check.id === aId)).toMatchObject({ status: "in_progress", conclusion: null });
      f.summaryStatus(503);
      expect(await f.reviews.execute(f.session(a.execution.id), "submit_review", f.assessment, randomUUID()))
        .toMatchObject({ status: "failed", receipt: { retryable: true, providerStatus: 503 } });
      const [aPublication] = await f.publications();
      const b = await f.attempt(kind);
      await f.worker.processPending();
      const bPending = await f.readReview(b.review.id), bId = Number(bPending.checkId);
      expect.soft(bId, "a distinct authorized attempt must not reactivate A's pending or completed check").not.toBe(aId);
      expect.soft(bPending).toMatchObject({ id: b.review.id, runId: b.execution.id, assessment: null, state: "running" });
      expect.soft(f.checks.find(check => check.id === bId)).toMatchObject({ status: "in_progress", conclusion: null });
      const before = f.checkWrites.length, remoteBefore = structuredClone(f.checks);
      f.summaryStatus(null);
      await f.duePublication();
      await githubChatReviewService(f.db, f.providerFetch).processPending();
      const delayedWrites = f.checkWrites.slice(before);
      expect.soft(delayedWrites.filter(write => write.id === bId), "resuming A must not mutate B's check").toEqual([]);
      expect.soft(delayedWrites.filter(write => write.method === "POST"), "A must not create a fresh stale result after B owns pending").toEqual([]);
      expect.soft(f.checks.find(check => check.id === bId)).toEqual(remoteBefore.find(check => check.id === bId));
      expect.soft(f.checks.map(check => check.id)).toEqual(remoteBefore.map(check => check.id));
      expect.soft(await f.readReview(b.review.id)).toMatchObject({ id: b.review.id, runId: b.execution.id,
        deliveryId: b.review.deliveryId, checkId: bPending.checkId, assessment: null, state: "running" });
      expect.soft((await f.publications()).find(action => action.id === aPublication.id)?.payload)
        .toMatchObject({ session: { runId: a.execution.id } });
      const bAssessment = { ...f.assessment, score: 3, summary: "B found remaining work" };
      expect(await f.reviews.execute(f.session(b.execution.id), "submit_review", bAssessment, randomUUID()))
        .toMatchObject({ status: "processed" });
      expect.soft(f.checks.find(check => check.id === bId)).toMatchObject({ status: "completed", conclusion: "failure" });
      const bDone = await f.readReview(b.review.id);
      expect.soft(bDone).toMatchObject({ id: b.review.id, runId: b.execution.id, checkId: bPending.checkId,
        assessment: bAssessment, conclusion: "failure", state: "completed" });
      const settled = structuredClone(f.checks), writes = f.checkWrites.length;
      await f.duePublication();
      await f.reviews.processPending();
      await f.worker.processPending();
      expect.soft(f.checkWrites.slice(writes)).toEqual([]);
      expect.soft(f.checks).toEqual(settled);
      expect(f.unexpected).toEqual([]);
    });
  });

  it.each(["manual", "automatic"] as const)("opens a distinct %s lifecycle without reactivating a confirmed completed success", async kind => {
    await withFixture(async f => {
      const historical = await f.published(), remote = structuredClone(f.checks);
      const b = await f.attempt(kind);
      await f.worker.processPending();
      const pending = await f.readReview(b.review.id), id = Number(pending.checkId);
      expect.soft(pending.checkId, "fresh authority cannot reactivate a completed assessment check").not.toBe(historical.checkId);
      expect.soft(f.checks.find(check => String(check.id) === historical.checkId)).toEqual(remote[0]);
      expect.soft(f.checks.find(check => check.id === id)).toMatchObject({ status: "in_progress", conclusion: null });
      const assessment = { ...f.assessment, score: 3, summary: "New attempt is nonpassing" };
      expect(await f.reviews.execute(f.session(b.execution.id), "submit_review", assessment, randomUUID()))
        .toMatchObject({ status: "processed" });
      expect.soft(f.checks.find(check => check.id === id)).toMatchObject({ status: "completed", conclusion: "failure" });
      expect.soft(f.checks.find(check => String(check.id) === historical.checkId)).toEqual(remote[0]);
      expect.soft(await f.readReview(historical.id)).toEqual(historical);
      expect.soft(await f.readReview(b.review.id)).toMatchObject({ id: b.review.id, runId: b.execution.id,
        deliveryId: b.review.deliveryId, checkId: pending.checkId, assessment, state: "completed", conclusion: "failure" });
      expect(f.unexpected).toEqual([]);
    });
  });

  it("allows delayed A to finish when newer B was never claimed or authorized", async () => {
    await withFixture(async f => {
      const a = await f.attempt();
      await f.worker.processPending();
      const aId = (await f.readReview(a.review.id)).checkId;
      f.summaryStatus(503);
      await f.reviews.execute(f.session(a.execution.id), "submit_review", f.assessment, randomUUID());
      const b = await f.receipt({ state: "filtered" });
      await f.worker.processPending();
      const before = f.checkWrites.length;
      f.summaryStatus(null); await f.duePublication(); await f.reviews.processPending();
      expect.soft(f.checkWrites.slice(before)).toEqual([expect.objectContaining({ id: Number(aId),
        body: expect.objectContaining({ status: "completed", conclusion: "success" }) })]);
      expect.soft(f.checks.find(check => String(check.id) === aId)).toMatchObject({ status: "completed", conclusion: "success" });
      expect.soft(await f.readReview(a.review.id)).toMatchObject({ id: a.review.id, runId: a.execution.id, checkId: aId,
        assessment: f.assessment, state: "completed" });
      expect.soft(await f.readReview(b.review!.id)).toMatchObject({ runId: null, assessment: null });
      expect(f.unexpected).toEqual([]);
    });
  });

  it.each([
    { terminal: "failed", pending: true }, { terminal: "cancelled", pending: true },
    { terminal: "failed", pending: false }, { terminal: "cancelled", pending: false },
  ] as const)("preserves a confirmed completed receipt after final action bookkeeping is $terminal (initial pending: $pending)", async ({ terminal, pending: hadPending }) => {
    await withFixture(async f => {
      const a = await f.attempt();
      if (hadPending) await f.worker.processPending();
      const pending = await f.readReview(a.review.id), name = `publication_fault_${randomUUID().replaceAll("-", "")}`;
      expect(pending.checkId).toEqual(hadPending ? expect.any(String) : null);
      await f.db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.endpoint_id = '${f.endpoint.id}'::uuid AND NEW.kind = 'github_review_publication' AND NEW.status = 'processed'
        THEN RAISE EXCEPTION 'synthetic final review commit rejected'; END IF; RETURN NEW; END $$`));
      await f.db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE UPDATE ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${name}()`));
      try {
        expect(await f.reviews.execute(f.session(a.execution.id), "submit_review", f.assessment, randomUUID()))
          .toMatchObject({ status: "failed" });
      } finally {
        await f.db.execute(sql.raw(`DROP TRIGGER ${name} ON chat_actions`));
        await f.db.execute(sql.raw(`DROP FUNCTION ${name}()`));
      }
      const confirmed = await f.readReview(a.review.id), [publication] = await f.publications();
      expect(confirmed.checkId).toEqual(expect.any(String));
      if (hadPending) expect(confirmed.checkId).toBe(pending.checkId);
      expect(f.checkWrites.at(-1)).toMatchObject({ id: Number(confirmed.checkId),
        body: { status: "completed", conclusion: "success" } });
      expect(f.checks.find(check => String(check.id) === confirmed.checkId))
        .toMatchObject({ status: "completed", conclusion: "success" });
      expect(publication.payload).toMatchObject({ session: { runId: a.execution.id } });
      expect(publication.status).not.toBe("processed");
      await f.db.update(chatActions).set({ status: terminal, result: { ...publication.result, retryable: false,
        providerStatus: 403, error: "Synthetic final bookkeeping disposition" } }).where(eq(chatActions.id, publication.id));
      const history = await f.readReview(a.review.id), remote = structuredClone(f.checks), before = f.checkWrites.length;
      const duplicate = await failedDuplicate(f);
      await f.worker.processPending();
      expect.soft(f.checkWrites.slice(before), "a completed provider receipt is evidence even when final action bookkeeping did not commit").toEqual([]);
      expect.soft(f.checks).toEqual(remote);
      expect.soft(await f.readReview(history.id)).toEqual(history);
      expect.soft(await f.readReview(duplicate.review.id)).toMatchObject({ id: duplicate.review.id,
        runId: duplicate.execution.id, assessment: null, state: "error", conclusion: "action_required" });
      expect(f.unexpected).toEqual([]);
    });
  });

  it.each(["pending", "null"] as const)("does not treat a %s check ID or intended success as confirmed assessment publication", async receipt => {
    await withFixture(async f => {
      const a = await f.attempt();
      if (receipt === "pending") await f.worker.processPending();
      const original = await f.readReview(a.review.id);
      expect(original.checkId).toEqual(receipt === "pending" ? expect.any(String) : null);
      f.summaryStatus(403);
      expect(await f.reviews.execute(f.session(a.execution.id), "submit_review", f.assessment, randomUUID()))
        .toMatchObject({ status: "failed", receipt: { retryable: false, providerStatus: 403 } });
      const historical = await f.readReview(a.review.id);
      expect(historical).toMatchObject({ assessment: f.assessment, conclusion: "success", checkId: original.checkId });
      expect(f.checks.every(check => check.status !== "completed")).toBe(true);
      const duplicate = await failedDuplicate(f), before = f.checkWrites.length;
      await f.worker.processPending();
      const current = await f.readReview(duplicate.review.id);
      expect.soft(current).toMatchObject({ id: duplicate.review.id, runId: duplicate.execution.id, assessment: null,
        state: "error", conclusion: "action_required", checkId: expect.any(String) });
      expect.soft(f.checkWrites.slice(before).at(-1)).toMatchObject({ id: Number(current.checkId),
        body: { status: "completed", conclusion: "action_required" } });
      expect.soft(f.checks.find(check => String(check.id) === current.checkId)).toMatchObject({ status: "completed", conclusion: "action_required" });
      expect.soft(await f.readReview(historical.id)).toEqual(historical);
      expect(f.unexpected).toEqual([]);
    });
  });

  it("never recovers old action A's run onto newer runless review B", async () => {
    await withFixture(async f => {
      const a = await f.receipt(), oldRun = await f.run("failed", a);
      const b = await f.receipt({ enqueue: false });
      const action = await f.checkAction(a.event), before = f.checkWrites.length;
      expect(a.review!.runId).toBeNull(); expect(b.review!.runId).toBeNull();
      await f.worker.processPending();
      expect.soft(await f.readReview(b.review!.id), "the selected review must not borrow a different receipt's run")
        .toMatchObject({ id: b.review!.id, deliveryId: b.delivery.id, runId: null, assessment: null, checkId: null });
      const recoveredA = await f.readReview(a.review!.id);
      for (const write of f.checkWrites.slice(before).filter(write => write.body.status === "completed")) {
        expect.soft(recoveredA, "any terminal result from A's action must remain bound to A's own receipt and run")
          .toMatchObject({ id: a.review!.id, deliveryId: a.delivery.id, runId: oldRun.id, checkId: String(write.id) });
      }
      const saved = (await f.actions()).find(row => row.id === action.id)!;
      expect.soft(saved.payload).toEqual(action.payload);
      expect.soft(await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldRun.id)))
        .toEqual([oldRun]);
      expect(f.unexpected).toEqual([]);
    });
  });

  it("retains newest matching-delivery no-assessment recovery without borrowing across companies", async () => {
    await withFixture(async f => {
      const foreign = await attemptFixture(f.db, 315), other = await foreign.receipt({ enqueue: false });
      const source = await f.receipt(), run = await f.run("failed", source);
      await f.worker.processPending();
      const recovered = await f.readReview(source.review!.id);
      expect(recovered).toMatchObject({ id: source.review!.id, deliveryId: source.delivery.id, runId: run.id,
        state: "error", assessment: null, conclusion: "action_required", checkId: expect.any(String) });
      expect(f.checks.find(check => String(check.id) === recovered.checkId)).toMatchObject({ status: "completed", conclusion: "action_required" });
      expect(await foreign.readReview(other.review!.id)).toMatchObject({ id: other.review!.id, runId: null, checkId: null });
      expect(foreign.checkWrites).toEqual([]); expect(f.unexpected).toEqual([]); expect(foreign.unexpected).toEqual([]);
    });
  });

  it.each([false, true])("targets the attempt-bound check independently of provider array reversal: %s", async reversed => {
    await withFixture(async f => {
      const a = await f.attempt(); await f.worker.processPending();
      const bound = await f.readReview(a.review.id), id = Number(bound.checkId);
      const original = f.checks.find(check => check.id === id)!;
      const unrelated = { ...structuredClone(original), id: 701, html_url: "https://github.com/acme/widget/checks/701" };
      const untouched = structuredClone(unrelated);
      f.checks.push(unrelated);
      if (reversed) f.reverseChecks();
      const before = f.checkWrites.length;
      expect(await f.reviews.execute(f.session(a.execution.id), "submit_review", f.assessment, randomUUID()))
        .toMatchObject({ status: "processed" });
      expect.soft(f.checkWrites.slice(before)).toEqual([expect.objectContaining({ method: "PATCH", id,
        path: `/repos/acme/widget/check-runs/${id}`, body: expect.objectContaining({ status: "completed", conclusion: "success" }) })]);
      expect.soft(f.checks.find(check => check.id === 701)).toEqual(untouched);
      expect.soft(f.checks.find(check => check.id === id)).toMatchObject({ status: "completed", conclusion: "success" });
      expect.soft(await f.readReview(a.review.id)).toMatchObject({ runId: a.execution.id, checkId: String(id), assessment: f.assessment });
      expect(f.unexpected).toEqual([]);
    });
  });

  it.each([false, true])("leaves ambiguous identical provider bindings unresolved instead of choosing by position: %s", async reversed => {
    await withFixture(async f => {
      const a = await f.attempt(); await f.worker.processPending();
      const pending = await f.readReview(a.review.id), action = await f.checkAction(pending.event);
      const original = f.checks.find(check => String(check.id) === pending.checkId)!;
      f.checks.push({ ...structuredClone(original), id: 702, html_url: "https://github.com/acme/widget/checks/702" });
      await f.db.update(chatGitHubReviews).set({ checkId: null, checkUrl: null }).where(eq(chatGitHubReviews.id, pending.id));
      await f.db.update(chatActions).set({ result: null }).where(eq(chatActions.id, action.id));
      if (reversed) f.reverseChecks();
      const remote = structuredClone(f.checks), before = f.checkWrites.length;
      await f.reviews.execute(f.session(a.execution.id), "submit_review", f.assessment, randomUUID());
      expect.soft(f.checkWrites.slice(before), "ambiguous receipts must not select an arbitrary matching check").toEqual([]);
      expect.soft(f.checks).toEqual(remote);
      expect.soft(await f.readReview(a.review.id)).toMatchObject({ id: a.review.id, runId: a.execution.id,
        deliveryId: a.review.deliveryId, assessment: f.assessment, checkId: null });
      const [publication] = await f.publications();
      expect.soft(publication.status, "unconfirmed provider work must remain an explicit unresolved obligation").not.toBe("processed");
      expect(f.unexpected).toEqual([]);
    });
  });

  it.each(["pending", "null"] as const)("reconstructs retained %s-ID replacement work through retryable-to-permanent publication and becomes quiet", async receipt => {
    const workerDatabase = await startEmbeddedPostgresTestDatabase("github-retained-attempt-");
    const workerDb = createDb(workerDatabase.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0,
      connectTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    const f = await attemptFixture(workerDb), errors: unknown[] = [];
    let coordinator = createDeliveryWorkCoordinator({ owner: workerDb, canRun: () => true, onError: error => errors.push(error) });
    try {
      const older = await f.published();
      const a = await f.attempt();
      if (receipt === "pending") await f.worker.processPending();
      const pending = await f.readReview(a.review.id);
      expect(pending.checkId).toEqual(receipt === "pending" ? expect.any(String) : null);
      f.summaryStatus(503);
      const assessment = { ...f.assessment, score: 3, summary: "Newest assessment still needs work" };
      expect(await f.reviews.execute(f.session(a.execution.id), "submit_review", assessment, randomUUID()))
        .toMatchObject({ status: "failed", receipt: { retryable: true, providerStatus: 503 } });
      await f.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, a.execution.id));
      const duplicate = await failedDuplicate(f), remote = structuredClone(f.checks), before = f.checkWrites.length;
      await f.worker.processPending();
      const suppressed = await f.checkAction(duplicate.source.event);
      expect(suppressed).toMatchObject({ status: "processed", result: { code: "assessment_owns_check" } });
      expect(f.checkWrites).toHaveLength(before); expect(f.checks).toEqual(remote);
      expect(await f.readReview(a.review.id)).toMatchObject({ assessment, checkId: pending.checkId });
      const activePublication = (await f.publications()).find(action => action.payload?.session
        && (action.payload.session as { runId?: string }).runId === a.execution.id)!;
      expect(activePublication).toMatchObject({ status: "failed", result: { retryable: true } });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await f.worker.registerCheckWork(coordinator, () => true).ready;
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 5000 }).toBe(0);
      expect.soft(coordinator.nextWakeAt(), "retryable publication plus a suppressed replacement is a concrete future obligation").not.toBeNull();
      await coordinator.stop();
      coordinator = createDeliveryWorkCoordinator({ owner: workerDb, canRun: () => true, onError: error => errors.push(error) });
      await githubReviewCheckService(workerDb, f.providerFetch).registerCheckWork(coordinator, () => true).ready;
      expect.soft(coordinator.nextWakeAt(), "reconstruction must restore the retained obligation without enqueue").not.toBeNull();
      f.summaryStatus(403);
      await f.duePublication();
      await f.reviews.processPending();
      expect((await f.publications()).find(action => action.id === activePublication.id))
        .toMatchObject({ status: "failed", result: { retryable: false, providerStatus: 403 } });
      await vi.advanceTimersByTimeAsync(6000);
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 5000 }).toBe(0);
      const settled = await f.readReview(duplicate.review.id), action = await f.checkAction(duplicate.source.event);
      expect.soft(settled).toMatchObject({ id: duplicate.review.id, deliveryId: duplicate.source.delivery.id,
        runId: duplicate.execution.id, state: "error", assessment: null, conclusion: "action_required", checkId: expect.any(String) });
      expect.soft(f.checkWrites.slice(before).at(-1), "permanent failure must release the retained replacement lifecycle, never an older passing score")
        .toMatchObject({ id: Number(settled.checkId), body: { status: "completed", conclusion: "action_required" } });
      expect.soft(f.checks.find(check => String(check.id) === settled.checkId)).toMatchObject({ status: "completed", conclusion: "action_required" });
      expect.soft(action.id).toBe(suppressed.id);
      expect.soft(action).toMatchObject({ status: "processed" });
      expect.soft(await f.readReview(a.review.id)).toMatchObject({ assessment, runId: a.execution.id });
      expect.soft(await f.readReview(older.id)).toEqual(older);
      await expect.poll(() => idleWorkSnapshot().active, { timeout: 5000 }).toBe(0);
      expect.soft(coordinator.nextWakeAt(), "settled retained history must not schedule another scan").toBeNull();
      const requestCount = f.requests.length, reads = vi.spyOn(workerDb, "select"), transactions = vi.spyOn(workerDb, "transaction");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect.soft(reads).not.toHaveBeenCalled(); expect.soft(transactions).not.toHaveBeenCalled();
        expect.soft(f.requests).toHaveLength(requestCount);
      } finally { reads.mockRestore(); transactions.mockRestore(); }
      expect(errors).toEqual([]); expect(f.unexpected).toEqual([]);
    } finally {
      await coordinator.stop(); vi.useRealTimers();
      await workerDb.$client.end({ timeout: 0 }); await workerDatabase.cleanup();
    }
  }, 45_000);
});
