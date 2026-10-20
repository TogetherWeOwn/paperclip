import { describe, expect, it } from "vitest";
import { githubReviewExecutionTrustDecision } from "../services/chat-github-task-trust.js";

const REPOSITORY_ID = "71001";
const AUTHOR_ID = "81001";
const BOT_ID = "91001";
const HEAD_SHA = "a".repeat(40);

function provenance(overrides: Partial<{
  baseRepositoryId: string | null;
  headRepositoryId: string | null;
  authorId: string;
  authorIsBot: boolean;
  headSha: string;
}> = {}) {
  return {
    baseRepositoryId: REPOSITORY_ID,
    headRepositoryId: REPOSITORY_ID,
    authorId: AUTHOR_ID,
    authorIsBot: false,
    headSha: HEAD_SHA,
    ...overrides,
  };
}

function decision(overrides: Partial<Parameters<typeof githubReviewExecutionTrustDecision>[0]> = {}) {
  return githubReviewExecutionTrustDecision({
    provenance: provenance(),
    repositoryId: REPOSITORY_ID,
    authorIsLinkedMember: true,
    trustedBotAuthorIds: [],
    ...overrides,
  });
}

function expectTrust(result: ReturnType<typeof decision>, lowTrust: boolean) {
  expect(result.lowTrust).toBe(lowTrust);
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim().length).toBeGreaterThan(0);
}

describe("GitHub review execution trust follows API PR provenance", () => {
  it("permits a same-repository PR authored by an active linked company member", () => {
    expectTrust(decision(), false);
  });

  it("permits an explicitly allowlisted API Bot author without a linked human", () => {
    expectTrust(decision({
      provenance: provenance({ authorId: BOT_ID, authorIsBot: true }),
      authorIsLinkedMember: false,
      trustedBotAuthorIds: [BOT_ID],
    }), false);
  });

  it("does not trust a same-repository outside collaborator just because a member triggered review", () => {
    expectTrust(decision({ authorIsLinkedMember: false }), true);
  });

  it("does not trust a Bot by type alone", () => {
    expectTrust(decision({
      provenance: provenance({ authorId: BOT_ID, authorIsBot: true }),
      authorIsLinkedMember: false,
    }), true);
  });

  it("does not treat an allowlisted human account as a configured Bot", () => {
    expectTrust(decision({
      authorIsLinkedMember: false,
      trustedBotAuthorIds: [AUTHOR_ID],
    }), true);
  });

  it("does not match a different bot's stable ID", () => {
    expectTrust(decision({
      provenance: provenance({ authorId: BOT_ID, authorIsBot: true }),
      authorIsLinkedMember: false,
      trustedBotAuthorIds: ["91002"],
    }), true);
  });

  it.each([
    { name: "linked member", authorIsLinkedMember: true, authorIsBot: false, authorId: AUTHOR_ID },
    { name: "outside collaborator", authorIsLinkedMember: false, authorIsBot: false, authorId: AUTHOR_ID },
    { name: "allowlisted bot", authorIsLinkedMember: false, authorIsBot: true, authorId: BOT_ID },
  ])("keeps a fork low trust even for a $name author and a linked trigger", (author) => {
    expectTrust(decision({
      provenance: provenance({ headRepositoryId: "71002", authorId: author.authorId, authorIsBot: author.authorIsBot }),
      authorIsLinkedMember: author.authorIsLinkedMember,
      trustedBotAuthorIds: [BOT_ID],
    }), true);
  });

  it("does not trust API provenance for a different base repository", () => {
    expectTrust(decision({
      provenance: provenance({ baseRepositoryId: "71002", headRepositoryId: "71002" }),
    }), true);
  });

  it("fails closed when the PR API lookup fails or returns no provenance", () => {
    expectTrust(decision({ provenance: null }), true);
  });

  it.each(["baseRepositoryId", "headRepositoryId"] as const)("fails closed for missing/deleted %s", (field) => {
    expectTrust(decision({ provenance: provenance({ [field]: null }) }), true);
  });

  it.each(["", "0", "-1", "1.5", "not-a-github-id"])("fails closed for invalid configured repository ID %j", (repositoryId) => {
    expectTrust(decision({ repositoryId }), true);
  });

  it.each(["", "0", "-1", "1.5", "not-a-github-id"])("fails closed for invalid API author ID %j even if reported linked", (authorId) => {
    expectTrust(decision({ provenance: provenance({ authorId }) }), true);
  });

  it.each(["baseRepositoryId", "headRepositoryId"] as const)("does not accept an invalid API %s even when IDs compare equal", (field) => {
    expectTrust(decision({ provenance: provenance({ [field]: "0" }) }), true);
  });

  it("does not mutate provenance or configured bot identities", () => {
    const apiProvenance = Object.freeze(provenance());
    const trustedBotAuthorIds = [BOT_ID];
    const before = [...trustedBotAuthorIds];
    expectTrust(decision({ provenance: apiProvenance, trustedBotAuthorIds }), false);
    expect(trustedBotAuthorIds).toEqual(before);
    expect(apiProvenance).toEqual(provenance());
  });
});
