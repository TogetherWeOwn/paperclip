# Fork tracking — TogetherWeOwn/paperclip (tog6 line)

Ledger of fork-master refs vs `deploy/tog6` state for the tog release line.

## tog.9 checklist

Range: `75970755a8` (`origin/deploy/tog6` tip at audit time) .. `origin/master`
(`9986806907`) — 41 master-only commits. Fork PR #84 was never merged to
master; deploy already carries it via `ba1461caeb` (port #106), so it has no row.

Ported in this release: `877a4a0f` (#108, port of #61 `b3aad750`, nested checkouts that lost `.git`) + supplemental `9c0a032b` (#109, port of #102 `b29df24e`, stranded-evidence runId fallback; outside the 41-commit audit range so the audit count stays frozen) + supplemental `e4dcdade` (#110, wake-prompt rule that keeps tracker-id branch names off public repos plus merged-PR delivery by head SHA; also outside the audit range; ported from `fix/card-free-publish-warning-tog6`, merge SHA recorded here once merged).

| SHA | Subject | Verdict | Reason |
|-----|---------|---------|--------|
| b2dad8da | feat(plugins): inject host-computed budgetSpentFraction (#14) | already-equivalent | Deploy already carries the full #14 host-stamp via `863bacdd71` (tog.5 release #62, ancestor of deploy tip): `protocol.ts:433` + `types.ts:274` optional fraction, `worker-rpc-host.ts:1941` finite guard + `:1959` stamp, `budgets.ts:179` `runBudgetSpentFraction` (byte-identical to source), gateway stamps at `tool-gateway.ts:10448` (H5) + `:10914` (H6 B2), direct-dispatch overwrite at `plugins.ts:1143` (H6 B3) + action stamp at `:772` (H8, call sites `:1627`/`:1811`), run-end reap at `heartbeat.ts:27311-27356`, schema at `openapi.ts:8733`; source regression tests present (`plugin-budget-spent-fraction.test.ts` identical 4/4 pass, `budgets-service.test.ts:328` D1 pass, `worker-rpc-host.test.ts:159` H3 pass, `heartbeat-router-run-end-reap.test.ts:22` pass as #54 receipt superset). No duplicate port. |
| b293a48d | fix(adapter-utils): strip server secrets from agent child env (#16) | already-equivalent | Deploy already carries the full #16 denylist via `863bacdd71` (tog.5 release #62, ancestor of deploy tip): `server-utils.ts:3539` exact keys, `:3598` prefixes, `:3604` suffixes, `:3606` matcher + `:3617` sanitize bodies identical to source; deploy exact-keys are a strict superset (all 30 source keys present, only adds the 10 #17 keys), prefixes identical, suffixes add `_TOKEN`; all 6 source regression tests present in `server-utils-env.test.ts`, 9/9 pass. No duplicate port. |
| a931e8b6 | security(child-env): harden agent child env (#17) | already-equivalent | Deploy already carries the full #17 hardening via `863bacdd71` (tog.5 release #62, ancestor of deploy tip): `server-utils.ts:3566-3567` enterprise tokens, `:3583-3590` pointer vars, `:3603` `_TOKEN` suffix rule, plus sibling-spawn sanitize at `board-chat.ts:260`, `execution-workspaces.ts:706`, `native-codex-runner.ts:405`, `smoke-lab.ts:995-997`; all 3 source regression tests present in `server-utils-env.test.ts:49-79`, 9/9 pass. No duplicate port. |
| d777b8b6 | fix(wake-queue): preserve completed native reviews across deferred wakes (#22) | already-equivalent | Deploy already carries the full #22 change via `863bacdd71` (tog.5 release #62, ancestor of deploy tip): wake-queue port `ports.ts:170` + adapter `postgres.ts:422` (`commentsCoveredByCompletedReview`, domain file byte-identical) + use-case guard `use-cases.ts:339`; restoration route mounted at `app.ts:756` (route, receipt, evidence and restoration services byte-identical to source) with `restoreCompletedReviewSchema` at `validators/issue.ts:922`; `issues.ts` receipt collection at `:13654` (`completingTypedReview` `:13379`, `completionCommentId` `:13385`/`:13785`, deploy refactored the final-comment write into the transactional-comment path). All source regression tests present and pass 489/489 across 14 files (restoration routes, wake-queue module, receipt/evidence/restoration services, execution-policy, comment-reopen, openapi). No duplicate port. |
| 6d94dea6 | fix(heartbeat): merge issue override env per key (#23) | keep-for-tog.9 | Follow-up port: pins copied secret_refs that fail binding after reassignment. |
| 9b85ab13 | fix(server): survive closed child stdin without crashing controller (#24) | keep-for-tog.9 | Follow-up port: EPIPE-tolerant stdin handling. |
| 2ff804e8 | feat(heartbeat): run-scoped model decision hook (#27) | not-needed | Opt-in experimental feature; flag-off behavior is advisory-only. |
| bc28101e | fix(issues): restore redacted env placeholders on override PATCH (#30) | keep-for-tog.9 | Follow-up port: copying redacted env persisted literal `***REDACTED***`. |
| e60553d3 | fix(plugins): port H1-H9 host wiring onto 1001 line (#33) | not-needed | v2026.1001.0 release-line rebase bundle; not applicable to the 1005-based tog line. |
| 9df2fb2b | fix(heartbeat): keep cleanup SIGTERM from failing successful runs (#34) | keep-for-tog.9 | Follow-up port: successful runs marked failed by cleanup SIGTERM. |
| 54801af8 | ci(fork): call our own trusted PR workflow (#31) | not-needed | CI-only workflow wiring. |
| 829a7c79 | ci(nightly): gate promotion on exact-source onboarding smoke (#35) | not-needed | CI-only promotion gating. |
| cc26e5e0 | fix(codex-local): remove managed MCP bearer block at run end (#37) | keep-for-tog.9 | Follow-up port: run JWT + gateway bearers lingered on disk after run end. |
| 5e60ee01 | fix(workspace-runtime): fail closed on truncated git worktree lists (#38) | keep-for-tog.9 | Follow-up port: truncated `worktree list` misreported valid worktrees. |
| 56d88db4 | fix(heartbeat): reuse transaction connections for nested wake reads (#18) | keep-for-tog.9 | Follow-up port: in-transaction wake reads deadlocked on pooled db. |
| 742aa11d | feat(codex-local): add isolateRuntime for untrusted input (#42) | keep-for-tog.9 | Follow-up port: opt-in empty-env codex child safety boundary. |
| 302776c7 | fix(exe-dev): stage execution env in remote 0600 file, never argv (#19) | keep-for-tog.9 | Follow-up port: agent secrets visible in ssh argv. |
| 291a0f6b | fix(heartbeat): suppress run comments on no-progress wakes (#46) | keep-for-tog.9 | Follow-up port: no-op wakes spammed issue comments. |
| fc8f50a0 | feat(claude-local): opt-in isolateRuntime env allowlist (#55) | keep-for-tog.9 | Follow-up port: same boundary as #42 for claude-local. |
| 37a25da7 | fix(reviews): low-trust reviews may use review agent credential (#47) | keep-for-tog.9 | Follow-up port: low-trust review fix on the deploy line's core flow. |
| ee341c9b | fix(heartbeat): ignore monitor re-arm in progress measurement (#57) | keep-for-tog.9 | Follow-up port: follow-up to #46. |
| 64c73238 | feat(execution): route low-trust runs to a sandbox environment (#63) | keep-for-tog.9 | Follow-up port: unbound low-trust runs refused on local. |
| 78ea59f9 | fix(tool-gateway): extend run-scoped token TTL (#53) | already-equivalent | Deploy `2c517cf2ff` (fork #68); same change. |
| 4a1ef147 | fix(workspaces): restore recorded branch when HEAD drifted (#65) | already-equivalent | Deploy `c6799b3f52`; identical 7-file stat and hunk sizes. |
| ca25997c | fix(ssh): exclude agent-local scratch from sync, cap sync-back size (#56) | keep-for-tog.9 | Follow-up port: ENOSPC via /tmp staging. |
| e54004b9 | fix(issues): low-trust assignee may close its own blocked card (#66) | keep-for-tog.9 | Follow-up port: blocked-card close behavior fix. |
| b3aad750 | fix(sync): tolerate nested checkouts that lost .git (#61) | keep-for-tog.9 (ported via #108) | Ported on the deploy line via `877a4a0ffff2b9420575e6a041fd606172259a75` (#108); fixes the nested-toolkit setup failure on the deploy line. Supplemental #102 ported via `9c0a032bb9d31b67c5140fc1a9cd6d3fa1855057` (#109, outside audit range). |
| e4dcdade | fix(adapter-utils): warn against publishing card-named branches on public repos (#110) | supplemental (ported via fork PR from `fix/card-free-publish-warning-tog6`) | Outside the audit range, so no audit count. Deploy `server-utils.ts:2673` still ended at "keep all commits on it." and `execution-workspaces.ts` still matched the PR head ref to the workspace branch name. The port adds the public-repo publish rule (push HEAD to a card-free ref) and treats a merged PR whose head SHA equals the workspace HEAD as delivered, so card-free refs do not leave workspaces unmerged. Applied cleanly (4 files, +58/-5). |
| 7d7871b5 | fix(adapter-utils): prevent managed GitHub launcher recursion | keep-for-tog.9 | Follow-up port: launcher recursion bug; no deploy equivalent. |
| f2f1bad2 | fix(adapter-utils): match managed launchers by exact SHA-256 (#74) | keep-for-tog.9 | Follow-up port: legacy fingerprint accepted forged launchers. |
| 37964f2b | feat(connections): server-mediated GET-only GitHub Actions diagnostics (#75) | keep-for-tog.9 | Follow-up port: additive read-only review-bot diagnostics parity. |
| ff05eba7 | fix(issues): map routine slot collision to 409 on checkout adoption (#83) | keep-for-tog.9 | Follow-up port: correct status code on slot collision. |
| f36f8749 | feat(server): stage timing for GitHub credential resolution (#89) | keep-for-tog.9 | Follow-up port: port together with #90 (stacked credential path). |
| f750be7b | fix(adapter): deliver child stdin before onSpawn persist (#87) | keep-for-tog.9 | Follow-up port: slow DB persist pushed prompts past the CLI stdin timeout. |
| 584b0bf2 | feat(chat-github): deterministic review template (#79) | already-equivalent | Deploy `cffd3bce15` (port #103) covers #79. |
| 0d0c4a65 | fix(server): cache GitHub installation tokens per repository (#90) | keep-for-tog.9 | Follow-up port: per-call minting caused 16s p50 / 52s 504s. |
| 40600440 | fix(chat-github): mint review thread ids in lowercase (#88) | keep-for-tog.9 | Follow-up port: mixed-case minting split PR threads/runs. |
| 9f0164b8 | fix(runner): gate warm attach rotation on attach-event commit (#96) | not-needed | Test-only; prod gate added then reverted. |
| 993151a6 | chore(lockfile): refresh pnpm-lock.yaml (#97) | not-needed | Lockfile churn only. |
| 7b243bc7 | fix(chat): keep GitHub chat output free of internal references (#78) | already-equivalent | Deploy `cffd3bce15` (port #103) covers #78. |
| 1c470343 | fix(chat-github): search all check runs before replacement (#100) | keep-for-tog.9 | Follow-up port: latest-only lookup caused duplicate POSTs. Deploy-tip #105 does not cover it (different change). |
| 99868069 | ci(workflows): repair validation and prevent fork publication (#40) | not-needed | CI-only validation + publication guard. |

Counts (audit range only; the supplemental ports #109 and #110 are outside it): keep-for-tog.9: 27 (1 ported here, 26 as follow-up small PRs) · already-equivalent: 7 · not-needed: 7.
