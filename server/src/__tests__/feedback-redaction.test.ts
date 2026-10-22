import { describe, expect, it } from "vitest";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
} from "../services/feedback-redaction.js";

// Obviously fake, alphabetic fixtures avoid the unrelated phone-number matcher.
const githubPrefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];

describe("feedback redaction", () => {
  it.each(githubPrefixes)("redacts standalone %s tokens and records their count", (prefix) => {
    const state = createFeedbackRedactionState();
    const fake = `${prefix}faketestvalueonlyletters`;
    const fieldPath = "run.stdout";
    const output = sanitizeFeedbackText(`first ${fake}; second ${fake}`, state, fieldPath, 1000);

    expect(output).toBe("first [REDACTED_GITHUB_TOKEN]; second [REDACTED_GITHUB_TOKEN]");
    expect(output).not.toContain(fake);
    const summary = finalizeFeedbackRedactionSummary(state);
    expect(summary.redactedFields).toEqual([fieldPath]);
    expect(summary.counts).toEqual({ github_token: 2 });
  });

  it("redacts fine-grained PATs in free-text arrays used by feedback context", () => {
    const state = createFeedbackRedactionState();
    const fake = "github_pat_fakecontexttestonlyletters";
    const output = sanitizeFeedbackValue([`trace ${fake}`, `context ${fake}`], state, "context", 1000);

    expect(output).toEqual(["trace [REDACTED_GITHUB_TOKEN]", "context [REDACTED_GITHUB_TOKEN]"]);
    expect(finalizeFeedbackRedactionSummary(state).redactedFields).toEqual(["context[0]", "context[1]"]);
    expect(finalizeFeedbackRedactionSummary(state).counts).toEqual({ github_token: 2 });
  });
});
