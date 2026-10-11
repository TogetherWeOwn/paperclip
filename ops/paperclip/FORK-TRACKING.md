# Fork tracking — TogetherWeOwn/paperclip (tog6 line)

Ledger of fork-master refs vs `deploy/tog6` state for the tog release line.

## tog.9 checklist

Range: `75970755a8` (`origin/deploy/tog6` tip at audit time) .. `origin/master`
(`9986806907`) — 41 master-only commits. Fork PR #84 was never merged to
master; deploy already carries it via `ba1461caeb` (port #106), so it has no row.

Ported in this release: `b3aad750` (#61, nested checkouts that lost `.git`) —
this PR (cherry-pick + adapt onto the tog6 line; the merge commit is recorded here on merge).

| SHA | Subject | Verdict | Reason |
|-----|---------|---------|--------|
| b2dad8da | feat(plugins): inject host-computed budgetSpentFraction (#14) | keep-for-tog.9 | Follow-up port: host stamps spend fraction so plugins cannot spoof budget state. |
| b293a48d | fix(adapter-utils): strip server secrets from agent child env (#16) | keep-for-tog.9 | Follow-up port: child inherited DATABASE_URL and wiped prod schema; fail-closed denylist. |
| a931e8b6 | security(child-env): harden agent child env (#17) | keep-for-tog.9 | Follow-up port: extends #16 (token-suffix rule, pointer vars, sibling spawns). |
| d777b8b6 | fix(wake-queue): preserve completed native reviews across deferred wakes (#22) | keep-for-tog.9 | Follow-up port: deferred wakes could drop completed native reviews. |
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
| b3aad750 | fix(sync): tolerate nested checkouts that lost .git (#61) | keep-for-tog.9 (ported here) | Ported in this release (this PR); fixes the nested-toolkit setup failure on the deploy line. |
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

Counts: keep-for-tog.9: 30 (1 ported here, 29 as follow-up small PRs) · already-equivalent: 4 · not-needed: 7.
