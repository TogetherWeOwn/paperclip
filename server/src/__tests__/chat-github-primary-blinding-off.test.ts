import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { githubPrimaryBlinding, installGitHubPrimaryApiBlinding } from "../services/chat-github-primary-blinding.js";
import { initializeGitHubPrimaryBlinding, withGitHubPrimaryBlindingAdmission } from "../services/chat-github-primary-blinding-state.js";

const payload = { description: '{\n "id": 12345678901234567890\n}', array: "[1, 2,   3]",
  previousAssessments: ["ordinary data"], isolationTests: { arbitrary: true },
  githubPairingSeed: { ordinary: true }, shadowLabel: "ordinary user data" };

describe("disabled primary blinding fast path", () => {
  it.each([payload, null, undefined, "plain text", 0, false])("does zero DB work and preserves response bytes for body %#", async body => {
    const calls = vi.fn(() => { throw new Error("Disabled blinding must not touch the DB"); });
    const db = new Proxy({}, { get: () => calls }) as Db;
    const visibility = await githubPrimaryBlinding(db, "off-company");
    expect(visibility.filter(body)).toBe(body);
    const app = express();
    app.set("json spaces", 2);
    app.get("/control", (_req, res) => res.json(body));
    app.get("/guarded", async (req, res) => {
      req.actor = { type: "agent", companyId: "off-company", agentId: "reader", source: "agent_key" };
      await installGitHubPrimaryApiBlinding(db, "off-company", req, res);
      res.json(body);
    });
    const before = await request(app).get("/control");
    const after = await request(app).get("/guarded");
    expect(after.status).toBe(200);
    expect(Buffer.from(after.text)).toEqual(Buffer.from(before.text));
    expect(after.headers["content-length"]).toBe(before.headers["content-length"]);
    expect(calls).toHaveBeenCalledTimes(0);
  });

  it("rechecks an initially off request when candidates are admitted before its response", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ key: "candidate", agents: ["candidate-agent"], tokens: ["candidate-issue"] }]);
    const db = { execute } as unknown as Db;
    const app = express();
    app.get("/admit-during-request", async (req, res) => {
      req.actor = { type: "agent", companyId: "new-company", agentId: "reader", source: "agent_key" };
      await installGitHubPrimaryApiBlinding(db, "new-company", req, res);
      expect(execute).not.toHaveBeenCalled();
      await withGitHubPrimaryBlindingAdmission(db, "new-company", async () => {});
      res.json([{ id: "public-issue" }, { id: "candidate-issue", body: "PRIVATE_CANDIDATE" }]);
    });
    const response = await request(app).get("/admit-during-request");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: "public-issue" }]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns to zero queries after a projection rolls back without candidates", async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ present: false }]);
    const db = { execute } as unknown as Db;
    await initializeGitHubPrimaryBlinding(db);
    await expect(withGitHubPrimaryBlindingAdmission(db, "rollback-company", async () => { throw new Error("rollback"); }))
      .rejects.toThrow("rollback");
    execute.mockClear();
    expect((await githubPrimaryBlinding(db, "rollback-company")).filter(payload)).toBe(payload);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps blinding on if startup cannot establish which companies have candidates", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("bootstrap unavailable"));
    const db = { execute } as unknown as Db;
    await expect(initializeGitHubPrimaryBlinding(db)).rejects.toThrow("bootstrap unavailable");
    // Even a caller that catches startup's error must not get a passthrough.
    await expect(githubPrimaryBlinding(db, "unknown-company")).rejects.toThrow("bootstrap unavailable");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("arms before projection and retains enrollment without consulting the shadow switch", async () => {
    const execute = vi.fn().mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ key: "empty", agents: [], tokens: [] }])
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ key: "candidate", agents: ["candidate-agent"], tokens: ["candidate-issue"] }]);
    const db = { execute } as unknown as Db;
    await initializeGitHubPrimaryBlinding(db);
    await withGitHubPrimaryBlindingAdmission(db, "new-company", async () => {
      // The transaction has not made any candidate rows visible yet.
      await githubPrimaryBlinding(db, "new-company");
      expect(execute).toHaveBeenCalledTimes(2);
    });
    const visibility = await githubPrimaryBlinding(db, "new-company");
    expect(() => visibility.assertVisible("candidate-issue")).toThrow(/not found/i);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("does not let an older empty admission probe erase a concurrent enrollment", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const queryStarted = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn().mockResolvedValueOnce([])
      .mockImplementationOnce(async () => { started(); await blocked; return [{ present: false }]; })
      .mockResolvedValueOnce([{ present: true }])
      .mockResolvedValueOnce([{ key: "candidate", agents: ["candidate-agent"], tokens: ["candidate-issue"] }]);
    const db = { execute } as unknown as Db;
    await initializeGitHubPrimaryBlinding(db);
    const older = withGitHubPrimaryBlindingAdmission(db, "racing-company", async () => {});
    await queryStarted;
    try { await withGitHubPrimaryBlindingAdmission(db, "racing-company", async () => {}); }
    finally { release(); await older; }
    const visibility = await githubPrimaryBlinding(db, "racing-company");
    expect(() => visibility.assertVisible("candidate-issue")).toThrow(/not found/i);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("keeps blinding on after an uncertain admission outcome", async () => {
    const execute = vi.fn().mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("commit visibility unavailable"))
      .mockResolvedValueOnce([{ key: "candidate", agents: ["candidate-agent"], tokens: ["candidate-issue"] }]);
    const db = { execute } as unknown as Db;
    await initializeGitHubPrimaryBlinding(db);
    await expect(withGitHubPrimaryBlindingAdmission(db, "uncertain-company", async () => {}))
      .rejects.toThrow("commit visibility unavailable");
    const visibility = await githubPrimaryBlinding(db, "uncertain-company");
    expect(() => visibility.assertVisible("candidate-issue")).toThrow(/not found/i);
  });

  it("never joins a watermark statement that started before the reader arrived", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const queryStarted = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn().mockResolvedValueOnce([{ company_id: "active-company" }])
      .mockImplementationOnce(async () => { started(); await blocked; return [{ key: "old", agents: ["candidate"], tokens: ["candidate"] }]; })
      .mockResolvedValueOnce([{ key: "new", agents: ["candidate"], tokens: ["candidate", "late-alias"] }]);
    const db = { execute } as unknown as Db;
    await initializeGitHubPrimaryBlinding(db);
    const first = githubPrimaryBlinding(db, "active-company");
    await queryStarted;
    const second = githubPrimaryBlinding(db, "active-company");
    release();
    const [old, fresh] = await Promise.all([first, second]);
    expect(() => old.assertVisible("late-alias")).not.toThrow();
    expect(() => fresh.assertVisible("late-alias")).toThrow(/not found/i);
    expect(execute).toHaveBeenCalledTimes(3); // Bootstrap + two ordered snapshots.
  });
});
