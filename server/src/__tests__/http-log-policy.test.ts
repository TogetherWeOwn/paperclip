import { describe, expect, it } from "vitest";
import {
  isPrivateWebhookHttpRequest,
  isSecretSensitiveHttpRequest,
  requestLogUrl,
  shouldSilenceHttpSuccessLog,
} from "../middleware/http-log-policy.js";

describe("isPrivateWebhookHttpRequest", () => {
  it("protects the native webhook namespace, including rejected methods and query data", () => {
    for (const provider of [
      "slack",
      "github",
      "discord",
      "telegram",
      "microsoft-teams",
    ]) {
      for (const method of ["POST", "GET", "PUT", "DELETE"]) {
        for (const suffix of ["", "/", "?ignored=private"]) {
          const path = `/api/chat-webhooks/endpoint-1/${provider}${suffix}`;
          expect(isPrivateWebhookHttpRequest(method, path)).toBe(true);
          expect(isSecretSensitiveHttpRequest(method, path)).toBe(true);
        }
      }
    }
    expect(
      isPrivateWebhookHttpRequest("POST", "/API/CHAT-WEBHOOKS/id/SLACK"),
    ).toBe(true);
    for (const path of [
      "/api/routine-triggers/public",
      "/api/routine-triggers/public/private-id/fire",
      "https://host.invalid/api/routine-triggers/public/../private-id",
      "/api/chat-webhooks",
      "/api/chat-webhooks/id",
      "/api/chat-webhooks/id/slack/history",
      "/api/chat-webhooks//slack",
      "/api/chat-webhooks/%2Fprivate/%XX",
      "http://host.invalid/api/chat-webhooks/id/slack?private=true",
      "http://host.invalid/api/chat-webhooks/../private-component",
      "HTTPS://user:private@host.invalid/API/CHAT-WEBHOOKS/id/SLACK/",
    ])
      expect(isPrivateWebhookHttpRequest("POST", path)).toBe(true);
  });

  it("does not change adjacent non-webhook routes", () => {
    for (const path of [
      "/api/routine-triggers/id/rotate-secret",
      "/api/routine-triggers/public-extra/id/fire",
      "/api/chat-webhooks-extra/id/slack",
      "https://host.invalid/api/chat-webhooks-extra/id/slack",
      "/api/other/chat-webhooks/id/slack",
      "/api/chat-endpoints/id/test",
      "/chat-webhooks/id/slack",
    ])
      expect(isPrivateWebhookHttpRequest("POST", path)).toBe(false);
    expect(
      isPrivateWebhookHttpRequest(undefined, "/api/chat-webhooks/id/slack"),
    ).toBe(false);
    expect(isPrivateWebhookHttpRequest("POST", undefined)).toBe(false);
  });
});

describe("isSecretSensitiveHttpRequest", () => {
  it("identifies credential-bearing chat setup mutations", () => {
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/chat-endpoints/endpoint-1/setup",
      ),
    ).toBe(true);
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/chat-endpoints/endpoint-1/setup-secret?rotation=true",
      ),
    ).toBe(true);
    expect(
      isSecretSensitiveHttpRequest(
        "GET",
        "/api/chat-endpoints/endpoint-1/setup",
      ),
    ).toBe(false);
    expect(
      isSecretSensitiveHttpRequest(
        "POST",
        "/api/chat-endpoints/endpoint-1/test",
      ),
    ).toBe(false);
  });
});

describe("shouldSilenceHttpSuccessLog", () => {
  it("silences cached 304 responses", () => {
    expect(
      shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 304),
    ).toBe(true);
  });

  it("silences successful polling endpoints", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/heartbeat-runs",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/heartbeat-runs/b7044268-19b6-4b3a-a9f3-9c57dce70253/log?offset=1103894&limitBytes=256000",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/live-runs?minCount=3",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "HEAD",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/sidebar-badges",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/issues?includeRoutineExecutions=true",
        200,
      ),
    ).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/api/companies/5cbe79ee-acb3-4597-896e-7662742593cd/activity",
        200,
      ),
    ).toBe(true);
  });

  it("silences successful static asset requests", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/", 200)).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/index.html", 200)).toBe(true);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/@fs/Users/dotta/paperclip/ui/src/main.tsx",
        200,
      ),
    ).toBe(true);
    expect(shouldSilenceHttpSuccessLog("GET", "/src/App.tsx?t=123", 200)).toBe(
      true,
    );
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(
      true,
    );
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
  });

  it("keeps normal successful application requests", () => {
    expect(
      shouldSilenceHttpSuccessLog("GET", "/api/issues/PAP-1383", 200),
    ).toBe(false);
    expect(
      shouldSilenceHttpSuccessLog("PATCH", "/api/issues/PAP-1383", 200),
    ).toBe(false);
  });

  it("keeps failing requests visible", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
    expect(
      shouldSilenceHttpSuccessLog(
        "GET",
        "/@fs/Users/dotta/paperclip/ui/src/main.tsx",
        404,
      ),
    ).toBe(false);
  });
});

describe("requestLogUrl", () => {
  it("collapses bearer tokens in invite and board-claim paths, keeping sub-paths", () => {
    const cases: Array<[string, string]> = [
      ["/api/invites/pcp_invite_SECRETTOKEN123", "/api/invites/:token"],
      [
        "/api/invites/pcp_invite_SECRETTOKEN123/accept",
        "/api/invites/:token/accept",
      ],
      [
        "/api/invites/pcp_invite_SECRETTOKEN123/skills/paperclip",
        "/api/invites/:token/skills/paperclip",
      ],
      ["/api/board-claim/rawtoken456", "/api/board-claim/:token"],
      ["/api/board-claim/rawtoken456/claim", "/api/board-claim/:token/claim"],
    ];
    for (const [input, expected] of cases) {
      for (const method of ["GET", "POST"]) {
        const logged = requestLogUrl({ method, url: input });
        expect(logged).toBe(expected);
        expect(logged).not.toContain("SECRETTOKEN123");
        expect(logged).not.toContain("rawtoken456");
      }
    }
  });

  it("strips query strings and userinfo while collapsing tokens", () => {
    expect(
      requestLogUrl({
        method: "GET",
        url: "/api/invites/pcp_invite_SECRETTOKEN123/accept?next=/board#frag",
      }),
    ).toBe("/api/invites/:token/accept");
    expect(
      requestLogUrl({ method: "GET", url: "/api/issues?token=secret" }),
    ).toBe("/api/issues");
  });

  it("leaves adjacent non-token routes untouched", () => {
    for (const path of [
      "/api/invites",
      "/api/invites-extra/abc",
      "/api/board-claim",
      "/api/companies/acme/issues",
      "/api/tool-gateway/gateway-tokens/token-id-1/revoke",
    ]) {
      expect(requestLogUrl({ method: "GET", url: path })).toBe(path);
    }
  });

  it("still collapses webhook ids to route templates", () => {
    expect(
      requestLogUrl({
        method: "POST",
        originalUrl: "/api/chat-webhooks/endpoint-9/slack",
        url: "/api/chat-webhooks/endpoint-9/slack",
      }),
    ).toBe("/api/chat-webhooks/:publicId/:provider");
  });

  it("prefers originalUrl over mount-stripped req.url for token collapse", () => {
    // Regression: at response-finish time Express has stripped the /api
    // mount prefix from req.url, so collapsing req.url left the raw bearer
    // token in the pino msg field of server.log and stdout.
    expect(
      requestLogUrl({
        method: "GET",
        originalUrl: "/api/invites/pcp_invite_SECRETTOKEN123",
        url: "/invites/pcp_invite_SECRETTOKEN123",
      }),
    ).toBe("/api/invites/:token");
    expect(
      requestLogUrl({
        method: "POST",
        originalUrl: "/api/board-claim/rawtoken456/claim",
        url: "/board-claim/rawtoken456/claim",
      }),
    ).toBe("/api/board-claim/:token/claim");
  });

  it("collapses mount-relative token paths when originalUrl is unavailable", () => {
    expect(
      requestLogUrl({ method: "GET", url: "/invites/pcp_invite_SECRETTOKEN123" }),
    ).toBe("/invites/:token");
    expect(
      requestLogUrl({ method: "POST", url: "/board-claim/rawtoken456/claim" }),
    ).toBe("/board-claim/:token/claim");
  });
});
