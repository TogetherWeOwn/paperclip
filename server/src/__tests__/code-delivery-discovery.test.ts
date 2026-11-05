import { describe, expect, it } from "vitest";
import type { codeDeliveryDecisions, codeDeliveryDiscoveries, codeDeliveryObligations } from "@paperclipai/db";
import { discoverGitHubPullRequest, matchDeliveryDiscovery } from "../services/code-delivery-discovery.js";

type Discovery = typeof codeDeliveryDiscoveries.$inferSelect;
type Obligation = typeof codeDeliveryObligations.$inferSelect;
type Decision = typeof codeDeliveryDecisions.$inferSelect;

const discovery = { id: "discovery", companyId: "company", issueId: "issue", sourceRevision: "revision",
  snapshot: { type: "pull_request", url: "https://github.com/fixture/source/pull/12" } } as Discovery;
const obligation = { id: "obligation", provider: "github", companyId: "company", ownerIssueId: "issue",
  sourceIssueId: "issue", repository: "fixture/source", pullRequestNumber: 12 } as Obligation;
const decision = { id: "decision", companyId: "company", issueId: "issue", obligationId: "obligation", kind: "accept_head",
  payload: { reconciliations: [{ discoveryId: "discovery", sourceRevision: "revision", obligationId: "obligation" }] } } as Decision;

describe("retained code-delivery discovery identity", () => {
  it.each(["https://github.com/Fixture/Source/pull/12", "https://github.com/fixture/source/pull/12/files",
    "https://github.com/fixture/source/pull/12/commits?diff=split#diff-a", "https://github.com/fixture/source/pull/12/checks/"])("discovers %s without treating it as live evidence", url => {
    expect(discoverGitHubPullRequest(url)).toEqual({ repository: "fixture/source", number: 12 });
  });
  it.each([null, {}, "http://github.com/fixture/source/pull/12", "https://github.com.evil.invalid/fixture/source/pull/12",
    "https://token@github.com/fixture/source/pull/12", "https://github.com:444/fixture/source/pull/12",
    "https://api.github.com/repos/fixture/source/pulls/12", "https://github.com/fixture/source/pull/0",
    "https://github.com/fixture/source/pull/01", "https://github.com/fixture/source/pull/2147483648",
    "https://github.com/fixture/source/pull/12/unknown", "https://github.com/fixture/source/pull/%31%32",
    "https://github.com/fixture/source/pulls/12", "https://github.com/fixture/source/pull/12text"])("leaves invalid discovery unresolved: %s", url => {
    expect(discoverGitHubPullRequest(url)).toBeNull();
  });
  it("matches a retained canonical PR after ownership transfer without moving display data", () => {
    expect(matchDeliveryDiscovery(discovery, [{ ...obligation, ownerIssueId: "destination" }]))
      .toEqual({ discoveryId: discovery.id, obligationId: obligation.id, decisionId: null });
  });
  it.each(["company", "owner", "repository", "number"])("does not bind wrong %s from a URL", fault => {
    const wrong = { ...obligation, ...(fault === "company" ? { companyId: "other" } : fault === "owner"
      ? { ownerIssueId: "other", sourceIssueId: "other" } : fault === "repository" ? { repository: "fixture/other" } : { pullRequestNumber: 1 }) };
    expect(matchDeliveryDiscovery(discovery, [wrong]).obligationId).toBeNull();
  });
  it("requires independent exact discovery-revision evidence for branch reconciliation", () => {
    const branch = { ...discovery, snapshot: { type: "branch" } };
    expect(matchDeliveryDiscovery(branch, [obligation])).toMatchObject({ obligationId: null, decisionId: null });
    expect(matchDeliveryDiscovery(branch, [obligation], [decision])).toMatchObject({ obligationId: obligation.id, decisionId: decision.id });
    expect(matchDeliveryDiscovery({ ...branch, sourceRevision: "later" }, [obligation], [decision]))
      .toMatchObject({ obligationId: null, decisionId: null });
  });
  it.each(["wrong_company", "wrong_issue", "wrong_kind", "wrong_obligation", "wrong_revision", "no_obligation"])("does not reconcile with %s decision", fault => {
    const branch = { ...discovery, snapshot: { type: "commit" } };
    const wrong = { ...decision, ...(fault === "wrong_company" ? { companyId: "other" } : fault === "wrong_issue"
      ? { issueId: "other" } : fault === "wrong_kind" ? { kind: "transfer" as const } : fault === "wrong_obligation"
        ? { obligationId: "other" } : fault === "wrong_revision" ? { payload: { reconciliations: [{ discoveryId: "discovery", sourceRevision: "other", obligationId: "obligation" }] } } : {}) };
    expect(matchDeliveryDiscovery(branch, fault === "no_obligation" ? [] : [obligation], [wrong]))
      .toMatchObject({ obligationId: null, decisionId: null });
  });
  it("retains no-PR reconciliation as a decision, not a forged canonical obligation", () => {
    const branch = { ...discovery, snapshot: { type: "branch" } };
    const noPr = { ...decision, kind: "no_pr" as const, obligationId: null,
      payload: { reconciliations: [{ discoveryId: discovery.id, sourceRevision: discovery.sourceRevision, obligationId: null }] } };
    expect(matchDeliveryDiscovery(branch, [], [noPr])).toEqual({ discoveryId: discovery.id, obligationId: null, decisionId: decision.id });
  });
});
