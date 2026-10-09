import { describe, expect, it } from "vitest";
import type {
  GitHubReviewAssessment,
  GitHubReviewFinding,
} from "@paperclipai/shared";
import { githubReviewAssessmentSchema } from "@paperclipai/shared";
import {
  githubCommitPermalink,
  githubFilePermalink,
  renderCheckSummary,
  renderInlineFinding,
  renderReviewSummary,
  REVIEW_POST_MAX_CHARS,
  REVIEW_POST_TRUNCATION_SUFFIX,
} from "./chat-github-review-template.js";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";

const HEAD_SHA = "a".repeat(40);
const REPOSITORY = "acme/web";

function finding(
  overrides: Partial<GitHubReviewFinding> = {},
): GitHubReviewFinding {
  return {
    key: "k1",
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "error",
    category: "reliability",
    title: "Missing null check",
    body: "The handler dereferences user without a guard.",
    ...overrides,
  };
}

function assessment(
  overrides: Partial<GitHubReviewAssessment> = {},
): GitHubReviewAssessment {
  return {
    reviewedCommit: HEAD_SHA,
    score: 5,
    complete: true,
    summary: "Clean change with tests.",
    rationale: "Checked auth paths.",
    coverage: {
      reviewedPaths: ["src/a.ts"],
      omittedPaths: [],
      limitations: [],
    },
    findings: [],
    ...overrides,
  };
}

describe("GitHub file permalinks", () => {
  it("percent-encodes Markdown parentheses in path segments", () => {
    expect(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/a)(b.ts", 10),
    ).toBe(
      `https://github.com/${REPOSITORY}/blob/${HEAD_SHA}/src/a%29%28b.ts#L10`,
    );
  });
});

describe("renderReviewSummary", () => {
  it("renders a passing review with zero findings", () => {
    const out = renderReviewSummary({
      assessment: assessment(),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(out.startsWith("## Paperclip Review — 5/5")).toBe(true);
    expect(out).toContain(`[\`${HEAD_SHA}\`](${githubCommitPermalink(REPOSITORY, HEAD_SHA)})`);
    expect(out).toContain("Files reviewed: 1");
    expect(out).toContain("No actionable defects found");
    expect(out).toContain("Coverage: 1 file(s) reviewed");
    expect(out).not.toContain("Task:");
    expect(out).not.toContain("[Run]");
  });

  it("renders findings table and per-finding details", () => {
    const out = renderReviewSummary({
      assessment: assessment({
        score: 3,
        findings: [
          finding({
            evidence: "crash on empty session",
            suggestion: "if (!user) throw new AuthError();",
          }),
          finding({
            key: "k2",
            path: "src/b.ts",
            line: 3,
            severity: "warning",
            category: "security",
            title: "Weak token compare",
            body: "Uses == for tokens.",
          }),
        ],
      }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(out).toContain("| 1 | 🔴 Error | Missing null check |");
    expect(out).toContain("| 2 | 🟡 Warning | Weak token compare |");
    expect(out).toContain(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/a.ts", 10),
    );
    expect(out).toContain("```suggestion");
    expect(out).toContain("crash on empty session");
    expect(out).toContain("<details>");
    expect(out).not.toContain("…truncated");
  });

  it("keeps Markdown title and location outside the HTML summary block", () => {
    const out = projectSafeChatPublicationText(renderReviewSummary({
      assessment: assessment({
        score: 3,
        findings: [finding({ title: "Missing null check (empty input)." })],
      }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    }));
    const details = out.slice(out.indexOf("<details>"));
    expect(details.split("\n")[0]).toBe(
      "<details><summary>1. 🔴 Error</summary>",
    );
    expect(details).toContain(
      "\n\n**Missing null check \\(empty input\\)\\.** · reliability · " +
      `[${String.raw`src\/a\.ts\:10`}](https://github.com/${REPOSITORY}/blob/${HEAD_SHA}/src/a.ts)\n\nWhat:`,
    );
  });

  it("uses the base SHA for deleted LEFT-side paths with basePath", () => {
    const baseSha = "c".repeat(40);
    const leftFinding = finding({
      side: "LEFT",
      path: "src/deleted.ts",
      basePath: "src/deleted.ts",
    });
    const input = {
      assessment: assessment({ findings: [leftFinding] }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha,
    };
    const summary = renderReviewSummary(input);
    const inline = renderInlineFinding({
      finding: leftFinding,
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha,
    });

    expect(summary).toContain(
      githubFilePermalink(REPOSITORY, baseSha, "src/deleted.ts", 10),
    );
    expect(summary).not.toContain(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/deleted.ts", 10),
    );
    expect(inline).toContain(
      githubFilePermalink(REPOSITORY, baseSha, "src/deleted.ts", 10),
    );
    expect(inline).not.toContain(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/deleted.ts", 10),
    );
  });

  it("uses the base filename and SHA for renamed LEFT-side findings", () => {
    const baseSha = "c".repeat(40);
    const renamedFinding = finding({
      side: "LEFT",
      path: "src/new.ts",
      basePath: "src/old.ts",
    });
    const input = {
      assessment: assessment({
        findings: [renamedFinding],
        coverage: {
          reviewedPaths: ["src/new.ts", "src/old.ts"],
          omittedPaths: [],
          limitations: [],
        },
      }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha,
    };
    const summary = renderReviewSummary(input);
    const inline = renderInlineFinding({
      finding: renamedFinding,
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha,
    });

    expect(summary).toContain(String.raw`src\/old\.ts\:10`);
    expect(summary).toContain(
      githubFilePermalink(REPOSITORY, baseSha, "src/old.ts", 10),
    );
    expect(summary).not.toContain(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/new.ts", 10),
    );
    expect(inline).toContain(String.raw`src\/old\.ts\:10`);
    expect(inline).toContain(
      githubFilePermalink(REPOSITORY, baseSha, "src/old.ts", 10),
    );
    expect(inline).not.toContain(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/new.ts", 10),
    );
  });

  it("does not guess a file permalink for legacy LEFT findings", () => {
    const baseSha = "c".repeat(40);
    const legacyFinding = finding({ side: "LEFT", path: "src/legacy.ts" });
    const input = {
      assessment: assessment({ findings: [legacyFinding] }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha,
    };
    const summary = renderReviewSummary(input);
    const inline = renderInlineFinding({
      finding: legacyFinding,
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha,
    });

    expect(summary).toContain(String.raw`LEFT side\, line 10`);
    expect(summary).not.toContain(
      githubFilePermalink(REPOSITORY, baseSha, "src/legacy.ts", 10),
    );
    expect(inline).toContain(String.raw`LEFT side\, line 10`);
    expect(inline).not.toContain(
      githubFilePermalink(REPOSITORY, baseSha, "src/legacy.ts", 10),
    );
  });

  it("keeps the findings table intact for pipe and newline titles", () => {
    const out = renderReviewSummary({
      assessment: assessment({
        score: 3,
        findings: [finding({ title: "Fix | this\nand that" })],
      }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(out).toContain("| 1 | 🔴 Error | Fix \\| this and that |");
    const row = out.split("\n").find((line) => line.startsWith("| 1 |"));
    expect(row).toContain("| 1 |");
    // Five structural column separators remain once the escaped pipe
    // in the title is removed from the count.
    expect((row ?? "").replace(/\\\|/g, "").split("|").length - 1).toBe(5);
    // The permalink still carries the full-SHA anchor pre-sanitizer.
    expect(out).toContain(
      githubFilePermalink(REPOSITORY, HEAD_SHA, "src/a.ts", 10),
    );
  });

  it("keeps model text literal instead of allowing Markdown or HTML", () => {
    const maliciousFinding = finding({
      path: "src/evil`](javascript:alert(1))",
      key: "key`]\n## injected",
      title: "<summary> *unsafe*",
      body: "</details>\n## injected\n[run](https://example.com/hidden)",
      evidence: "[internal](https://example.com/hidden)",
    });
    const input = {
      assessment: assessment({
        summary: "## [internal](https://example.com/hidden)\n<script>alert(1)</script>",
        rationale: "[run](https://example.com/hidden)",
        findings: [maliciousFinding],
      }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    };
    const summary = renderReviewSummary(input);
    const inline = renderInlineFinding({
      finding: maliciousFinding,
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });

    expect(summary).toContain(String.raw`\#\# \[internal\]`);
    expect(summary).toContain("&lt;script&gt;");
    expect(summary).toContain(String.raw`&lt;\/details&gt;`);
    expect(summary).toContain("&lt;summary&gt; \\*unsafe\\*");
    for (const post of [summary, inline]) {
      expect(post).not.toContain("](https://example.com/hidden)");
      expect(post).not.toContain("](javascript:");
      expect((post.match(/<details>/g) ?? []).length).toBe(
        (post.match(/<\/details>/g) ?? []).length,
      );
    }
  });

  it("omits a suggestion that could close the server-owned fence", () => {
    const maliciousFinding = finding({
      suggestion: "safe();\n```\n## injected",
    });
    const summary = renderReviewSummary({
      assessment: assessment({ findings: [maliciousFinding] }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    const inline = renderInlineFinding({
      finding: maliciousFinding,
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });

    for (const post of [summary, inline]) {
      expect(post).toContain(
        "Suggestion omitted because it contains an unsafe code fence.",
      );
      expect(post).not.toContain("## injected");
    }
  });

  it("renders an incomplete review", () => {
    const out = renderReviewSummary({
      assessment: assessment({ complete: false, score: 0, summary: "Partial." }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(out.startsWith("## Paperclip Review — Incomplete")).toBe(true);
  });

  it("truncates 300 findings at the ceiling", () => {
    const findings = Array.from({ length: 300 }, (_, i) =>
      finding({
        key: `k${i}`,
        path: `src/f${i}.ts`,
        line: i + 1,
        severity: "info",
        category: "maintainability",
        title: `Nit ${i} with a fairly long title to consume table space`,
        body: "Body text ".repeat(50),
        evidence: "e".repeat(100),
        suggestion:
          i === 0
            ? `</details>\n${"s".repeat(3989)}`
            : "s".repeat(4000),
      }),
    );
    const out = renderReviewSummary({
      assessment: assessment({ score: 4, findings }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    // The ceiling is enforced on the published unit (UTF-16 length), so
    // astral emoji in severity markers never push the post over it.
    expect(out.length).toBeLessThanOrEqual(REVIEW_POST_MAX_CHARS);
    expect(out.endsWith(REVIEW_POST_TRUNCATION_SUFFIX)).toBe(true);
    // The cut lands on a line boundary with every opened block re-closed.
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
    // A tag-shaped string in the suggestion is not a structural closer.
    expect(
      out.slice(0, -REVIEW_POST_TRUNCATION_SUFFIX.length),
    ).toMatch(/\n<\/details>$/);
  });

  it("never publishes a partially truncated replacement", () => {
    const suggestion = Array.from({ length: 50 }, (_, i) => `    return value_${i}`).join("\n");
    const out = renderReviewSummary({
      assessment: assessment({ findings: Array.from({ length: 300 }, (_, i) => finding({
        key: `k${i}`, title: `Finding ${i}`, suggestion,
      })) }),
      repository: REPOSITORY, pullNumber: 42, headSha: HEAD_SHA, baseSha: HEAD_SHA,
    });
    expect(out.endsWith(REVIEW_POST_TRUNCATION_SUFFIX)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(REVIEW_POST_MAX_CHARS);
    const blocks = [...out.matchAll(/```suggestion\n([\s\S]*?)\n```/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block[1]).toBe(suggestion);
    expect((out.match(/```/g) ?? []).length).toBe(blocks.length * 2);
  });

  it("holds the ceiling for astral-emoji-heavy posts", () => {
    const findings = Array.from({ length: 300 }, (_, i) =>
      finding({
        key: `k${i}`,
        path: `src/f${i}.ts`,
        line: i + 1,
        severity: "warning",
        category: "style",
        title: `🟡 Nit ${i} — trailing whitespace 🟡🔴`,
        body: "🟡".repeat(200),
      }),
    );
    const out = renderReviewSummary({
      assessment: assessment({ score: 2, findings }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(out.length).toBeLessThanOrEqual(REVIEW_POST_MAX_CHARS);
    expect(out.endsWith(REVIEW_POST_TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe("renderInlineFinding", () => {
  it("renders the deterministic inline header and blocks", () => {
    const out = renderInlineFinding({
      finding: finding({
        evidence: "crash on empty session",
        suggestion: "if (!user) throw new AuthError();",
      }),
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(
      out.startsWith(
        `**🔴 Error · reliability** — Missing null check · 3/5 · [\`${HEAD_SHA.slice(0, 7)}\`](${githubCommitPermalink(REPOSITORY, HEAD_SHA)})`,
      ),
    ).toBe(true);
    expect(out).toContain(
      `Evidence: [src\\/a\\.ts\\:10](${githubFilePermalink(REPOSITORY, HEAD_SHA, "src/a.ts", 10)}) — crash on empty session`,
    );
    expect(out).toContain("```suggestion");
    expect(out).toContain("<details><summary>Full context</summary>");
  });
});

describe("published output", () => {
  it("keeps the line number after the sanitizer strips URL fragments", () => {
    const rendered = renderReviewSummary({
      assessment: assessment({ score: 3, findings: [finding()] }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    expect(rendered).toContain("#L10");
    const published = projectSafeChatPublicationText(rendered);
    expect(published).toContain(String.raw`src\/a\.ts\:10`);
    expect(published).not.toContain("#L10");
    expect(published).toContain(`blob/${HEAD_SHA}/src/a.ts`);
  });

  it("keeps inline finding lines after sanitization", () => {
    const rendered = renderInlineFinding({
      finding: finding(),
      score: 3,
      complete: true,
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    });
    const published = projectSafeChatPublicationText(rendered);
    expect(published).toContain(String.raw`src\/a\.ts\:10`);
    expect(published).not.toContain("#L10");
  });

  it("keeps LEFT-side evidence on the base commit after sanitization", () => {
    const baseSha = "c".repeat(40);
    const leftFinding = finding({
      side: "LEFT",
      path: "src/deleted.ts",
      basePath: "src/deleted.ts",
    });
    const summary = projectSafeChatPublicationText(
      renderReviewSummary({
        assessment: assessment({ findings: [leftFinding] }),
        repository: REPOSITORY,
        pullNumber: 42,
        headSha: HEAD_SHA,
        baseSha,
      }),
    );
    const inline = projectSafeChatPublicationText(
      renderInlineFinding({
        finding: leftFinding,
        score: 3,
        complete: true,
        repository: REPOSITORY,
        headSha: HEAD_SHA,
        baseSha,
      }),
    );

    for (const post of [summary, inline]) {
      expect(post).toContain(String.raw`src\/deleted\.ts\:10`);
      expect(post).toContain(`blob/${baseSha}/src/deleted.ts`);
      expect(post).not.toContain(`blob/${HEAD_SHA}/src/deleted.ts`);
    }
  });

  it("sanitizes credentials and non-HTTPS URLs before Markdown escaping", () => {
    const summarySecret = "summary-secret-7231";
    const findingSecret = "finding-secret-8172";
    const sensitiveFinding = finding({
      title: `token=${findingSecret} http://example.com/title`,
      body: `token=${findingSecret} http://example.com/body`,
      evidence: `token=${findingSecret} http://example.com/evidence`,
      suggestion: `token=${findingSecret} http://example.com/suggestion`,
    });
    const input = {
      assessment: assessment({
        summary: `token=${summarySecret} http://example.com/summary`,
        findings: [sensitiveFinding],
      }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    };
    const posts = [
      renderReviewSummary(input),
      renderInlineFinding({
        finding: sensitiveFinding,
        score: 3,
        complete: true,
        repository: REPOSITORY,
        headSha: HEAD_SHA,
        baseSha: HEAD_SHA,
      }),
    ];

    for (const post of posts) {
      const published = projectSafeChatPublicationText(post);
      expect(published).not.toContain(summarySecret);
      expect(published).not.toContain(findingSecret);
      expect(published.replace(/\\/g, "")).not.toContain("example.com");
    }
  });
});

describe("renderCheckSummary", () => {
  it("matches the rendered PR comment summary", () => {
    const input = {
      assessment: assessment({ score: 3, findings: [finding()] }),
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    };
    expect(renderCheckSummary(input)).toBe(renderReviewSummary(input));
  });
});

describe("suggestion replacement integrity", () => {
  it("preserves significant indentation through strict validation and publication", () => {
    const suggestion = "    if user:\n        return user.id";
    const parsed = githubReviewAssessmentSchema.parse(assessment({
      findings: [finding({ suggestion })],
    }));
    expect(parsed.findings[0].suggestion).toBe(suggestion);
    const input = {
      assessment: parsed,
      repository: REPOSITORY,
      pullNumber: 42,
      headSha: HEAD_SHA,
      baseSha: HEAD_SHA,
    };
    const posts = [renderReviewSummary(input), renderInlineFinding({
      finding: parsed.findings[0], score: 3, complete: true,
      repository: REPOSITORY, headSha: HEAD_SHA, baseSha: HEAD_SHA,
    })];
    for (const post of posts)
      expect(projectSafeChatPublicationText(post)).toContain(`\`\`\`suggestion\n${suggestion}\n\`\`\``);
  });

  it.each([
    "    return user.id ",
    "return 1\n\n\nreturn 2",
    "    token=zzzzzzzz",
  ])("omits rather than silently edits a sanitized replacement: %s", (suggestion) => {
    const post = projectSafeChatPublicationText(renderInlineFinding({
      finding: finding({ suggestion }), score: 3, complete: true,
      repository: REPOSITORY, headSha: HEAD_SHA, baseSha: HEAD_SHA,
    }));
    expect(post).toContain("Suggestion omitted because publication sanitization would change the replacement.");
    expect(post).not.toContain("```suggestion");
    expect(post).not.toContain("zzzzzzzz");
  });
});

describe("assessment schema bounds", () => {
  it("rejects a null line and an over-long title", () => {
    const base = assessment({ findings: [finding()] });
    const nullLine = {
      ...base,
      findings: [{ ...finding(), line: null }],
    };
    expect(githubReviewAssessmentSchema.safeParse(nullLine).success).toBe(
      false,
    );
    const longTitle = {
      ...base,
      findings: [{ ...finding(), title: "t".repeat(121) }],
    };
    expect(githubReviewAssessmentSchema.safeParse(longTitle).success).toBe(
      false,
    );
    const pipeTitle = {
      ...base,
      findings: [{ ...finding(), title: "Fix | this" }],
    };
    expect(githubReviewAssessmentSchema.safeParse(pipeTitle).success).toBe(
      false,
    );
    const newlineTitle = {
      ...base,
      findings: [{ ...finding(), title: "Fix\nthis" }],
    };
    expect(githubReviewAssessmentSchema.safeParse(newlineTitle).success).toBe(
      false,
    );
    const leftWithoutBasePath = {
      ...base,
      findings: [finding({ side: "LEFT" })],
    };
    expect(githubReviewAssessmentSchema.safeParse(leftWithoutBasePath).success).toBe(
      false,
    );
    const leftWithUnreviewedBasePath = {
      ...base,
      findings: [finding({ side: "LEFT", basePath: "README.md" })],
    };
    expect(
      githubReviewAssessmentSchema.safeParse(leftWithUnreviewedBasePath).success,
    ).toBe(false);
    const renamedLeft = {
      ...base,
      findings: [
        finding({
          side: "LEFT",
          path: "src/new.ts",
          basePath: "src/old.ts",
        }),
      ],
      coverage: {
        ...base.coverage,
        reviewedPaths: [...base.coverage.reviewedPaths, "src/old.ts"],
      },
    };
    expect(githubReviewAssessmentSchema.safeParse(renamedLeft).success).toBe(
      true,
    );
    const samePathLeft = {
      ...base,
      findings: [finding({ side: "LEFT", basePath: "src/a.ts" })],
    };
    expect(githubReviewAssessmentSchema.safeParse(samePathLeft).success).toBe(
      true,
    );
    const longSummary = { ...base, summary: "s".repeat(2001) };
    expect(githubReviewAssessmentSchema.safeParse(longSummary).success).toBe(
      false,
    );
    expect(githubReviewAssessmentSchema.safeParse(base).success).toBe(true);
  });
});
