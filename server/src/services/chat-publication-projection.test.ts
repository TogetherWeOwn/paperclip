import { describe, expect, it } from "vitest";
import {
  UnsafeChatPublicationError,
  projectSafeChatPublication,
  projectSafeChatPublicationText,
  sanitizeExternalChatUrl,
  scrubExternalChatCard,
  scrubInternalReferences,
} from "./chat-publication-projection.js";

describe("chat publication projection", () => {
  it("removes reasoning, internal blocks, tool traces, and debug logs", () => {
    const input = [
      "Public summary.",
      "<analysis>secret deliberation</analysis>",
      "```tool_trace",
      "called dangerous_tool",
      "```",
      "## Internal notes",
      "do not publish this",
      "### Nested detail",
      "still private",
      "## Result",
      "Shipped safely.",
      "[DEBUG] raw provider response",
      "Reasoning: hidden one-line thought",
    ].join("\n");

    expect(projectSafeChatPublicationText(input)).toBe(
      "Public summary.\n\n## Result\nShipped safely.",
    );
  });

  it("redacts common credentials and private connection material", () => {
    const slackTokenCanary = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    const openAiKeyCanary = ["sk", "proj", "abcdefghijklmnopqrstuv"].join("-");
    const input = [
      `token: ${slackTokenCanary}`,
      `key ${openAiKeyCanary}`,
      "database postgresql://paperclip:hunter2@example.com/db",
      "-----BEGIN PRIVATE KEY-----",
      "definitely-private",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const projected = projectSafeChatPublicationText(input);
    expect(projected).not.toContain("xoxb-");
    expect(projected).not.toContain("sk-proj-");
    expect(projected).not.toContain("hunter2");
    expect(projected).not.toContain("definitely-private");
    expect(projected).toContain("[REDACTED]");
  });

  it("keeps HTTPS links but removes credentials, queries, fragments, and unsafe schemes", () => {
    const projected = projectSafeChatPublicationText(
      "Read [the report](https://docs.example.com/report?token=secret#private), " +
        "visit https://example.com/a?signature=abc#fragment, or javascript:alert(1).",
    );

    expect(projected).toContain("[the report](https://docs.example.com/report)");
    expect(projected).toContain("https://example.com/a");
    expect(projected).not.toContain("secret");
    expect(projected).not.toContain("signature");
    expect(projected).not.toContain("fragment");
    expect(projected).not.toContain("javascript:");
  });

  it("accepts only public HTTPS display links", () => {
    expect(sanitizeExternalChatUrl("https://example.com/path?q=secret#part")).toBe(
      "https://example.com/path",
    );
    expect(sanitizeExternalChatUrl("http://example.com/path")).toBeNull();
    expect(sanitizeExternalChatUrl("https://user:secret@example.com/path")).toBeNull();
    expect(sanitizeExternalChatUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeExternalChatUrl("https://localhost/private")).toBeNull();
    expect(sanitizeExternalChatUrl("https://192.168.1.8/private")).toBeNull();
  });

  it("neutralizes provider-wide mentions", () => {
    const projected = projectSafeChatPublicationText(
      "Notify @channel, @everyone, @here, and <!group>.",
    );
    expect(projected).toBe(
      "Notify @\u200bchannel, @\u200beveryone, @\u200bhere, and @\u200bgroup.",
    );
  });

  it("uses a safe fallback if only private material remains", () => {
    expect(projectSafeChatPublicationText("<thinking>all private</thinking>")).toBe(
      "Update available in Paperclip.",
    );
  });

  it("projects a classified payload with deduplicated attachments and a closed card schema", () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const payload = projectSafeChatPublication({
      classification: "external",
      source: "issue_interaction",
      text: "Please choose.",
      attachmentIds: [attachmentId, attachmentId.toUpperCase()],
      progressState: "waiting_for_input",
      interaction: {
        id: "interaction:123",
        card: {
          kind: "question",
          title: "Choose a path",
          body: "Do not leak token: super-secret-value",
          actions: [
            { type: "callback", actionId: "choice.one", label: "First", style: "primary" },
            {
              type: "link",
              label: "Open Paperclip",
              url: "https://paperclip.example/tasks/123?handoff=secret#private",
            },
            { type: "link", label: "Unsafe", url: "javascript:alert(1)" },
          ],
        },
      },
    });

    expect(payload).toEqual({
      text: "Please choose.",
      attachmentIds: [attachmentId],
      progressState: "waiting_for_input",
      interactionId: "interaction:123",
      card: {
        schema: "paperclip.chat.card.v1",
        kind: "question",
        title: "Choose a path",
        body: "Do not leak token: [REDACTED]",
        actions: [
          { type: "callback", actionId: "choice.one", label: "First", style: "primary" },
          {
            type: "link",
            label: "Open Paperclip",
            url: "https://paperclip.example/tasks/123",
          },
        ],
      },
    });
  });

  it("fails closed for malformed attachment and callback ids", () => {
    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "agent_comment",
        text: "Result",
        attachmentIds: ["../../other-company-secret"],
      }),
    ).toThrow(UnsafeChatPublicationError);

    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "issue_interaction",
        text: "Result",
        interaction: {
          id: "valid-id",
          card: {
            kind: "confirmation",
            title: "Proceed?",
            actions: [{ type: "callback", actionId: "bad action id", label: "Yes" }],
          },
        },
      }),
    ).toThrow(UnsafeChatPublicationError);

    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "issue_interaction",
        text: "Result",
        interaction: {
          id: "valid-id",
          card: {
            kind: "confirmation",
            title: "Proceed?",
            actions: [
              { type: "callback", actionId: "approve", label: "Yes", style: "rainbow" },
            ],
          },
        },
      } as never),
    ).toThrow(UnsafeChatPublicationError);
  });

  it("requires explicit external classification and closed enum values at runtime", () => {
    expect(() =>
      projectSafeChatPublication({
        classification: "internal",
        source: "agent_comment",
        text: "Private",
      } as never),
    ).toThrow(UnsafeChatPublicationError);

    expect(() =>
      projectSafeChatPublication({
        classification: "external",
        source: "agent_comment",
        text: "Update",
        progressState: "raw_tool_trace",
      } as never),
    ).toThrow(UnsafeChatPublicationError);
  });

  it("preserves a complete long Unicode result for durable provider transport", () => {
    const source = `${"a".repeat(99_990)}😀tail`;
    expect(projectSafeChatPublicationText(source)).toBe(source);
  });

  it("preserves expansion from sanitizing a maximum Board body", () => {
    const source = "@here ".repeat(16_666);
    const result = projectSafeChatPublicationText(source);
    expect(result).toBe(source.replaceAll("@here", "@\u200bhere").trim());
    expect(result.length).toBeGreaterThan(100_000);
  });

  it("refuses excessive sanitization input instead of silently truncating", () => {
    expect(() => projectSafeChatPublicationText("a".repeat(1_000_001))).toThrow(
      UnsafeChatPublicationError,
    );
  });
});

describe("scrubInternalReferences", () => {
  const scope = {
    internalOrigins: ["https://board.example.invalid"],
    trackerPrefixes: ["ACME"],
  };

  it("keeps the label of a markdown link to an internal origin", () => {
    expect(
      scrubInternalReferences(
        "Review [the change](https://board.example.invalid/issues/abc?token=1#top) now.",
        scope,
      ),
    ).toBe("Review the change now.");
  });

  it("keeps the label when the internal target is wrapped in angle brackets", () => {
    expect(
      scrubInternalReferences("[docs](<https://board.example.invalid/x>)", scope),
    ).toBe("docs");
  });

  it("replaces autolinks and bare internal URLs and keeps trailing punctuation", () => {
    expect(
      scrubInternalReferences(
        "See <https://board.example.invalid/x> and HTTPS://BOARD.example.invalid:8443/y, then stop.",
        scope,
      ),
    ).toBe(
      "See [internal link removed] and [internal link removed], then stop.",
    );
  });

  it("treats a trailing-dot hostname as the same internal host", () => {
    expect(
      scrubInternalReferences("Open https://board.example.invalid./x", scope),
    ).toBe("Open [internal link removed]");
  });

  it("accepts an internal origin configured without a scheme", () => {
    expect(
      scrubInternalReferences("Open https://board.example.invalid/x now.", {
        internalOrigins: ["board.example.invalid"],
        trackerPrefixes: [],
      }),
    ).toBe("Open [internal link removed] now.");
  });

  it("scans a long trailing punctuation run in linear time", () => {
    const text = `https://board.example.invalid/x${"!".repeat(200_000)}x`;
    expect(scrubInternalReferences(text, scope)).toBe(
      "[internal link removed]",
    );
  });

  it("rescans link labels for internal URLs and tracker ids", () => {
    expect(
      scrubInternalReferences(
        "[ACME-123](https://example.com/status) [https://board.example.invalid/x](https://board.example.invalid/x)",
        scope,
      ),
    ).toBe(
      "[[internal reference]](https://example.com/status) [internal link removed]",
    );
  });

  it("removes uppercase tracker ids of the company's own prefix only", () => {
    expect(scrubInternalReferences("Fixed ACME-123 and acme-7.", scope)).toBe(
      "Fixed [internal reference] and acme-7.",
    );
  });

  it("matches the company prefix case-sensitively", () => {
    expect(
      scrubInternalReferences("utf-8 UTF-8", {
        internalOrigins: [],
        trackerPrefixes: ["UTF"],
      }),
    ).toBe("utf-8 [internal reference]");
  });

  it("leaves other identifiers, lookalike hosts, and embedded prefixes untouched", () => {
    const text = [
      "SHA-256 CVE-2026-1234 UTF-8 XACME-123",
      "https://board.example.invalid.evil.example/x",
      "https://evilboard.example.invalid/x",
      "https://other.example.invalid/x",
    ].join(" ");
    expect(scrubInternalReferences(text, scope)).toBe(text);
  });

  it("escapes prefix characters and never treats an empty prefix as a wildcard", () => {
    expect(
      scrubInternalReferences("A.B-1 AxB-1 step-2", {
        internalOrigins: [],
        trackerPrefixes: ["A.B", ""],
      }),
    ).toBe("[internal reference] AxB-1 step-2");
  });

  it("is a no-op without internal origins or tracker prefixes", () => {
    const text = "ACME-123 at https://board.example.invalid/x";
    expect(
      scrubInternalReferences(text, {
        internalOrigins: [],
        trackerPrefixes: [],
      }),
    ).toBe(text);
  });
});

describe("scrubExternalChatCard", () => {
  it("scrubs title and body and drops link actions to internal origins", () => {
    expect(
      scrubExternalChatCard(
        {
          schema: "paperclip.chat.card.v1",
          kind: "question",
          title: "ACME-123 needs input",
          body: "Open https://board.example.invalid/issues/1 to respond.",
          actions: [
            {
              type: "link",
              label: "Open ACME-123",
              url: "https://board.example.invalid/issues/1",
            },
            { type: "link", label: "Docs", url: "https://example.com/docs" },
            { type: "callback", actionId: "approve", label: "Approve ACME-5" },
          ],
        },
        {
          internalOrigins: ["https://board.example.invalid"],
          trackerPrefixes: ["ACME"],
        },
      ),
    ).toEqual({
      schema: "paperclip.chat.card.v1",
      kind: "question",
      title: "[internal reference] needs input",
      body: "Open [internal link removed] to respond.",
      actions: [
        { type: "link", label: "Docs", url: "https://example.com/docs" },
        {
          type: "callback",
          actionId: "approve",
          label: "Approve [internal reference]",
        },
      ],
    });
  });
});
