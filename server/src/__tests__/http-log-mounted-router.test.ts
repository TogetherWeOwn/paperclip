import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";

describe("HTTP logger behind a mounted router", () => {
  it("keeps invite/board-claim bearer tokens out of every emitted field", async () => {
    // Regression: req.url is mount-stripped (/api/invites/<token> reads as
    // /invites/<token>) by response-finish time, so the /api-anchored token
    // collapse missed and the raw bearer token persisted in the pino msg
    // field. Runs the real httpLogger behind a real /api-mounted router,
    // mirroring production app.ts, and asserts the raw token appears
    // nowhere in the emitted lines, msg included.
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const app = express();
    app.use(createHttpLogger(pino({ level: "info" }, stream)));
    const router = express.Router();
    router.get("/invites/:token", (_req, res) => res.json({ ok: true }));
    router.post("/board-claim/:token/claim", (_req, res) =>
      res.status(400).json({ error: "expired" }),
    );
    app.use("/api", router);

    const inviteToken = "pcp_invite_MOUNTEDROUTERTOKEN1";
    const claimToken = "boardclaim_MOUNTEDROUTERTOKEN2";
    await request(app).get(`/api/invites/${inviteToken}`).expect(200);
    await request(app).post(`/api/board-claim/${claimToken}/claim`).expect(400);

    const deadline = Date.now() + 2000;
    while (chunks.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(chunks.length).toBe(2);
    const output = chunks.join("");
    expect(output).not.toContain(inviteToken);
    expect(output).not.toContain(claimToken);
    const [successLine, errorLine] = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(successLine?.msg).toBe("GET /api/invites/:token 200");
    expect(successLine?.req).toMatchObject({ url: "/api/invites/:token" });
    expect(String(errorLine?.msg)).toContain("/api/board-claim/:token/claim");
    expect(errorLine?.req).toMatchObject({
      url: "/api/board-claim/:token/claim",
    });
  });
});
