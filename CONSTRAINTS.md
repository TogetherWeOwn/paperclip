# Constraints

Last reviewed: 2026-10-11 by Founding Engineer (TOG-21618).

This file is the repo's quality bar. Agents: read it before writing code.
Do not weaken it to make a change pass. Tightening the bar is silent;
loosening it must be loud (a separate reviewed change, never bundled with
the feature that was failing).

## Floor (always enforced, no setup required)

- No new suppression comments (`@ts-ignore`, `eslint-disable`, `biome-ignore`,
  `istanbul ignore`, `nosemgrep`, `gitleaks:allow`)
- No unimplemented stubs (`throw new Error("Not implemented")`, empty `catch {}`)
- No skipped or deleted tests without a reason in the commit message
- No secrets in source
- This file does not get weakened to make a change pass

Checked by `pnpm guard:floor` (`scripts/quality-gates/floor-guard.mjs`),
HARD in CI and at task end. Exemptions live in the tracked
`.constraintsignore` file, never in a loosened rule.

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Floor | Zero floor-guard violations | `pnpm guard:floor` | task end, CI (HARD) |
| Shared pattern rules | No new shared-rule findings left unaddressed | `pnpm lint:ast-grep` (vendored meta-only pack, fixtures verified in-run) | CI (WARN in phase 1; promotes to HARD in phase 2). Reason: rules are owned outside this repo; WARN first while the baseline is measured |
| Gate tooling | Gate scripts self-test green | `pnpm test:quality-gates` | CI (HARD) |
| Lint (changed) | Zero Biome errors on changed files | `pnpm lint:biome:changed` | task end, CI (HARD). Full scan `pnpm lint:biome` is WARN until existing code is clean |
| Types | Zero type errors | `pnpm -r typecheck` | CI (HARD). Reason: the monorepo has no single `tsc -p .`; per-package typecheck is the real gate |
| Coverage (changed) | Changed lines >= 80% covered | `pnpm coverage:changed` | CI (WARN in phase 1; promotes to HARD in phase 2). Reason: 80% forces a test without blocking on config lines; WARN first because no baseline exists yet |
| Secrets | No secrets in source | gitleaks `detect` job | CI (WARN in phase 1). External opinion: the ruleset is maintained outside this repo |
| Dependencies | Nothing at moderate or above | `pnpm audit --audit-level=moderate` | CI (WARN in phase 1). Reason: moderate is the lowest level that stays actionable; below that is mostly noise |
| Known CVEs in images/deps | No HIGH/CRITICAL findings | Trivy `fs` job (pinned version in workflow) | CI (WARN in phase 1). External opinion: the vulnerability DB is maintained outside this repo |

Every row names the command that produces the verdict. A dimension with a
number and no command here is an aspiration, not a constraint.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Project-wide coverage | not yet baselined (first baseline lands with the phase-2 HARD gate) | must not fall once baselined |

## Exceptions

None. New rows use ID `W<n>` / `E<n>` with rule, path, reason, owner, and
expiry (max 90 days). A new row is a loud change: it needs reviewer
discussion, and the floor guard flags unreviewed additions.
