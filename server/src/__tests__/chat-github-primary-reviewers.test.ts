import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { githubPrimaryBlinding, installGitHubPrimaryApiBlinding } from "../services/chat-github-primary-blinding.js";
import { initializeGitHubPrimaryBlinding } from "../services/chat-github-primary-blinding-state.js";
import {
  initializeGitHubPrimaryReviewers, isGitHubPrimaryReviewer, refreshGitHubPrimaryReviewers,
  withGitHubPrimaryReviewerChange,
} from "../services/chat-github-primary-reviewers.js";

const companyId = "enrolled-company";
const rows = [{ company_id: companyId, assigned_agent_id: "primary" }];
const candidate = { key: "candidate", agents: ["candidate-agent"], tokens: ["candidate-issue"], database_snapshot: "10:10:" };
const body = [{ id: "public" }, { id: "candidate-issue", body: "PRIVATE" },
  { previousAssessments: ["user data"], json: '{\n "number": 12345678901234567890\n}' }];
async function fixture() {
  const execute = vi.fn().mockResolvedValueOnce([{ company_id: companyId }]).mockResolvedValueOnce(rows);
  const db = { execute } as unknown as Db;
  await initializeGitHubPrimaryBlinding(db);
  await initializeGitHubPrimaryReviewers(db);
  execute.mockReset();
  return { db, execute };
}
function appFor(db: Db, agentId: string, responseBody: unknown = body) {
  const app = express();
  app.set("json spaces", 2);
  app.get("/control", (_req, res) => res.json(responseBody));
  app.get("/guarded", async (req, res, next) => {
    req.actor = { type: "agent", companyId, agentId, source: "agent_key" };
    try { await installGitHubPrimaryApiBlinding(db, companyId, req, res); res.json(responseBody); }
    catch (error) { next(error); }
  });
  return app;
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("primary reviewer scope", () => {
  it.each([body, null, undefined, "plain text", 0, false])("does zero blinding DB work and preserves bytes for an enrolled non-primary, body %#", async value => {
    const { db, execute } = await fixture();
    execute.mockRejectedValue(new Error("Non-primary must not query blinding"));
    const app = appFor(db, "builder", value);
    const control = await request(app).get("/control");
    const actual = await request(app).get("/guarded");
    expect(actual.status).toBe(200);
    expect(Buffer.from(actual.text)).toEqual(Buffer.from(control.text));
    expect(actual.headers["content-length"]).toBe(control.headers["content-length"]);
    expect(execute).not.toHaveBeenCalled();
    expect(isGitHubPrimaryReviewer(db, "another-company", "primary")).toBe(false);
  });

  it("blinds the primary exactly as before, with one full snapshot and a cheap response watermark", async () => {
    const { db, execute } = await fixture();
    execute.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([{ database_snapshot: "10:10:" }]);
    const actual = await request(appFor(db, "primary")).get("/guarded");
    expect(actual.status).toBe(200);
    expect(actual.body).toEqual([{ id: "public" }, { json: body[2]!.json }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refreshes assignment changes and fences the commit-to-refresh window", async () => {
    const { db, execute } = await fixture();
    const read = gate(); const finish = gate();
    execute.mockImplementationOnce(async () => { read.resolve(); await finish.promise; return [{ assigned_agent_id: "replacement" }]; });
    const change = withGitHubPrimaryReviewerChange(db, companyId, async () => {
      expect(isGitHubPrimaryReviewer(db, companyId, "replacement")).toBe(true);
      expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(true);
    });
    await read.promise;
    expect(isGitHubPrimaryReviewer(db, companyId, "replacement")).toBe(true);
    finish.resolve(); await change;
    expect(isGitHubPrimaryReviewer(db, companyId, "replacement")).toBe(true);
    expect(isGitHubPrimaryReviewer(db, companyId, "primary")).toBe(false);
    expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(false);
  });

  it("blinds a non-primary response if its agent is promoted during the request", async () => {
    const { db, execute } = await fixture();
    const app = express();
    app.get("/promote", async (req, res) => {
      req.actor = { type: "agent", companyId, agentId: "builder", source: "agent_key" };
      await installGitHubPrimaryApiBlinding(db, companyId, req, res);
      expect(execute).not.toHaveBeenCalled();
      execute.mockResolvedValueOnce([{ assigned_agent_id: "builder" }]).mockResolvedValueOnce([candidate]);
      await withGitHubPrimaryReviewerChange(db, companyId, async () => {});
      res.json(body);
    });
    const actual = await request(app).get("/promote");
    expect(actual.status).toBe(200);
    expect(actual.text).not.toContain("PRIVATE");
  });

  it("does not let a stale refresh erase a newer endpoint assignment", async () => {
    const { db, execute } = await fixture();
    const read = gate(); const finish = gate();
    execute.mockImplementationOnce(async () => { read.resolve(); await finish.promise; return []; })
      .mockResolvedValueOnce([{ assigned_agent_id: "new-primary" }]);
    const old = refreshGitHubPrimaryReviewers(db, companyId);
    await read.promise;
    await withGitHubPrimaryReviewerChange(db, companyId, async () => {});
    finish.resolve(); await old;
    expect(isGitHubPrimaryReviewer(db, companyId, "new-primary")).toBe(true);
    expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(false);
  });

  it("stays closed during overlapping assignment transactions", async () => {
    const { db, execute } = await fixture();
    const finish = gate();
    execute.mockResolvedValue([{ assigned_agent_id: "new-primary" }]);
    const old = withGitHubPrimaryReviewerChange(db, companyId, () => finish.promise);
    await withGitHubPrimaryReviewerChange(db, companyId, async () => {});
    expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(true);
    finish.resolve(); await old;
    expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(false);
  });

  it("fails closed after a refresh error and recovers only after a successful read", async () => {
    const { db, execute } = await fixture();
    execute.mockRejectedValueOnce(new Error("scope unavailable")).mockResolvedValueOnce(rows);
    await expect(refreshGitHubPrimaryReviewers(db, companyId)).rejects.toThrow("scope unavailable");
    expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(true);
    await refreshGitHubPrimaryReviewers(db, companyId);
    expect(isGitHubPrimaryReviewer(db, companyId, "builder")).toBe(false);
  });

  it("blinds all agents when startup cannot load primary reviewers", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ company_id: companyId }])
      .mockRejectedValueOnce(new Error("startup unavailable"));
    const db = { execute } as unknown as Db;
    await initializeGitHubPrimaryBlinding(db);
    expect(isGitHubPrimaryReviewer(db, companyId, "unknown")).toBe(true);
    await expect(initializeGitHubPrimaryReviewers(db)).rejects.toThrow("startup unavailable");
    expect(isGitHubPrimaryReviewer(db, companyId, "unknown")).toBe(true);
    execute.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([{ database_snapshot: "10:10:" }]);
    const result = await request(appFor(db, "unknown")).get("/guarded");
    expect(result.status).toBe(200);
    expect(result.text).not.toContain("PRIVATE");
  });
});

describe("visibility watermark reuse", () => {
  it("reuses the full visibility only while the complete MVCC snapshot is unchanged", async () => {
    const { db, execute } = await fixture();
    execute.mockResolvedValueOnce([{ ...candidate, database_snapshot: "10:20:12" }])
      .mockResolvedValueOnce([{ database_snapshot: "10:20:12" }])
      // xmax did NOT change; an already-running transaction committed an alias.
      .mockResolvedValueOnce([{ database_snapshot: "10:20:" }])
      .mockResolvedValueOnce([{ ...candidate, key: "late", tokens: [...candidate.tokens, "late-alias"], database_snapshot: "10:20:" }]);
    const first = await githubPrimaryBlinding(db, companyId);
    expect(await githubPrimaryBlinding(db, companyId)).toBe(first);
    const final = await githubPrimaryBlinding(db, companyId);
    expect(() => first.assertVisible("late-alias")).not.toThrow();
    expect(() => final.assertVisible("late-alias")).toThrow(/not found/i);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not join a cheap watermark probe that started before the reader arrived", async () => {
    const { db, execute } = await fixture();
    const started = gate(); const finish = gate();
    execute.mockResolvedValueOnce([candidate])
      .mockImplementationOnce(async () => { started.resolve(); await finish.promise; return [{ database_snapshot: "10:10:" }]; })
      .mockResolvedValueOnce([{ database_snapshot: "11:11:" }])
      .mockResolvedValueOnce([{ ...candidate, key: "late", tokens: [...candidate.tokens, "late-alias"], database_snapshot: "11:11:" }]);
    const initial = await githubPrimaryBlinding(db, companyId);
    const older = githubPrimaryBlinding(db, companyId);
    await started.promise;
    const newer = githubPrimaryBlinding(db, companyId);
    finish.resolve();
    expect(await older).toBe(initial);
    expect(() => initial.assertVisible("late-alias")).not.toThrow();
    const fresh = await newer;
    expect(() => fresh.assertVisible("late-alias")).toThrow(/not found/i);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not return cached visibility if the cheap watermark cannot be read", async () => {
    const { db, execute } = await fixture();
    execute.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]);
    await githubPrimaryBlinding(db, companyId);
    await expect(githubPrimaryBlinding(db, companyId)).rejects.toThrow("watermark unavailable");
  });
});
