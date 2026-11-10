# Contributing Guide

Thanks for wanting to contribute!

We really appreciate both small fixes and thoughtful larger changes.

## Before You Start: Search First

Before you start work, **search GitHub** for existing PRs and issues that touch the same area:

- Look for **duplicate or in-flight PRs**. If something close already exists, prefer helping that PR over the line (see [Helping Other Contributors](#helping-other-contributors)) instead of opening a parallel one.
- Look for **related open issues**. Link them in your PR body.
- If an older PR is effectively dead (stale, unmaintained, would be painful to rebase/merge), a fresh PR is fine — just call out the prior PR in your description so the reviewer has context.

Duplicate PRs create extra work for reviewers and make merging harder. A 60-second search saves hours later.

Affirm that you did this search by checking the dedup-search box in the PR template (`I have searched GitHub for duplicate or related PRs and linked them above`). Commitperclip checks for this checkbox on non-trivial PRs.

## Two Paths to Get Your Pull Request Accepted

### Path 1: Small, Focused Changes (Fastest way to get merged)

- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure the change is very targeted and easy to review
- All tests pass and CI is green
- Greptile score is 5/5 with all comments addressed
- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)

These almost always get merged quickly when they're clean.

### Path 2: Bigger or Impactful Changes

- **First** talk about it in Discord → #dev channel  
  → Describe what you're trying to solve  
  → Share rough ideas / approach
- Once there's rough agreement, build it
- In your PR include:
  - Clear description of what & why
  - Proof it works (manual testing notes)
  - All tests passing and CI green
  - Greptile score 5/5 with all comments addressed
  - [PR template](.github/PULL_REQUEST_TEMPLATE.md) fully filled out

PRs that follow this path are **much** more likely to be accepted, even when they're large.

## PR Requirements (all PRs)

### Use the PR Template

Every pull request **must** follow the PR template at [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). If you create a PR via the GitHub API or other tooling that bypasses the template, copy its contents into your PR description manually. The template includes required sections: Thinking Path, What Changed, Verification, Risks, Model Used, and a Checklist.

### Link Issues or Describe Them In-PR

We do not gate PRs on a pre-existing issue. Two acceptable paths:

1. **Issue exists** — search the [Issues database](https://github.com/paperclipai/paperclip/issues) for anything this PR addresses and tag each one with `Fixes: #123` / `Closes #123` / `Refs #123` so GitHub auto-links them. If there are **duplicate or closely related issues**, link all of them, not just the one you picked. If there are **related PRs** (prior attempts, dependent work, follow-ups, abandoned predecessors), link those too.
2. **No issue exists** — describe the problem directly in your PR body, following one of our [issue templates](.github/ISSUE_TEMPLATE/) so a reviewer has the same fields they'd get from a filed issue:
   - **Bug fix:** what happened, expected behavior, steps to reproduce, Paperclip version/commit, deployment mode. See [`bug_report.yml`](.github/ISSUE_TEMPLATE/bug_report.yml).
   - **Feature:** problem/motivation, proposed solution, alternatives considered, roadmap alignment. See [`feature_request.yml`](.github/ISSUE_TEMPLATE/feature_request.yml).
   - **New adapter:** agent or provider, why it's useful, how it's invoked. See [`adapter_request.yml`](.github/ISSUE_TEMPLATE/adapter_request.yml).

Either way, a reviewer should be able to understand the underlying issue without leaving the PR. Commitperclip may check that one of these two paths is satisfied. Only link **public** GitHub issues — see [No Internal Issue References](#no-internal-issue-references) for what to leave out.

### No Internal Issue References

Many contributors run their own Paperclip instance to manage their work. Issue ids and links from *your* instance are private — reviewers and other contributors cannot open them, so they show up as clutter or broken links.

In your PR title, description, commits, and comments, **only reference public GitHub issues and PRs** — `#123`, `Fixes #123` / `Closes #123` / `Refs #123`, or full `https://github.com/paperclipai/paperclip/...` URLs.

Do **not** include references to internal/instance-local Paperclip work, such as:

- Internal ticket ids like `PAPA-123`, `PAP-224`, or any `{PREFIX}-{NUMBER}` identifier that isn't a public GitHub issue number.
- Instance UI links such as `/PAP/issues/...`, `/PAP/agents/...`, `agent://...`, or document deep links.
- `localhost`, private IP, or tailnet URLs pointing at your own instance.

If an internal issue captured useful context, restate that context in plain English in the PR body instead of linking to it.

### Branch Naming

Tooling (including Paperclip) often names a working branch after an internal issue and task — e.g. `PAPA-42-why-did-this-break`. That name leaks instance-local context, isn't meaningful to reviewers, and ends up as the public branch on your PR.

Before you push, **rename the branch to something descriptive of the change itself**, not of your instance:

- Use short, kebab-case names scoped to the change, optionally with a conventional prefix: `docs/no-internal-issue-references`, `fix/sandbox-secret-resolution`, `feat/adapter-retry-backoff`.
- Do **not** include internal Paperclip ticket ids (`PAPA-123`, `PAP-224`), instance task slugs, or other instance-derived details in the branch name.

To rename and push under the new name:

```bash
git branch -m <descriptive-name>
git push -u origin <descriptive-name>
# If your tooling already pushed the old branch, delete it from origin:
git push origin --delete <old-name>
```

### Model Used (Required)

Every PR must include a **Model Used** section specifying which AI model produced or assisted with the change. Include the provider, exact model ID/version, context window size, and any relevant capability details (e.g., reasoning mode, tool use). If no AI was used, write "None — human-authored". This applies to all contributors — human and AI alike.

### Bounded server checks without a build

Use Node.js 24.11+ and the pinned pnpm 9.15.4 from `packageManager`.
Run these commands from the repository root. Do not use the production server
`typecheck` script for a bounded pre-push check: it prepares runner and SDK build
outputs, including a Rust binary.

Reuse an existing frozen-lockfile install unless the lockfile changes. For a new
install, first check the one-minute load (`/proc/loadavg`) against `nproc`,
`MemAvailable` against `MemTotal` in `/proc/meminfo`, and disk use with `df /home`.
Do not install when load exceeds the CPU count, available memory is below 10%, or
`/home` is at least 85% full. Use a task-owned scratch directory and disable
lifecycle scripts:

```sh
scratch="$(mktemp -d)"
nice timeout -k 10 300 pnpm install --frozen-lockfile --ignore-scripts --store-dir "$scratch/pnpm-store"
```

Inventory install scripts and native dependencies before installing. pnpm 9 has no
native minimum-release-age control; the frozen lockfile pins this install and
`--ignore-scripts` disables all lifecycle scripts. Do not enable scripts, update
the lockfile, or build workspace packages to make these checks run. A failed
frozen install is missing verification, not a passing check.

Run the package/project type-check and covering tests as **separate commands**:

```sh
nice timeout -k 10 120 pnpm typecheck:server:changed server/src/__tests__/source-resolution.test.ts server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts
nice timeout -k 10 300 pnpm test:server:unit server/src/__tests__/source-resolution.test.ts server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts

# Select exact covering files for an issue-route or execution-policy change:
nice timeout -k 10 300 pnpm test:server:unit server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts server/src/__tests__/issue-execution-policy.test.ts

# Cover the selection/config tooling itself:
nice timeout -k 10 300 node --test scripts/__tests__/server-source-checks.test.mjs
```

`typecheck:server:changed` asks the installed compiler to expand the normal
`server/tsconfig.json` production roots. It unions those roots with the explicit
TypeScript test selection in a temporary no-emit project extending
`server/tsconfig.source.json`. It prints every effective root and checks the full
transitive import graph, including unselected tests reached by imports. It preserves
strictness, module resolution and the existing library-check policy. All diagnostics
fail the check; there is no baseline filter or selected-file waiver. The temporary
project is removed when the command exits normally. After a forced kill, remove only
this invocation's `server/.typecheck-*` directory, not another running check's files.

Select every applicable changed TypeScript test and the precise covering tests for
each changed behavior. The example above covers SDK/runner source resolution and
ownership-route fixture typing. The selector/project negative controls are in
`scripts/__tests__/server-source-checks.test.mjs`; JavaScript runtime tests do not
substitute for selected TypeScript tests. The compiler command shares runtime
selection validation but accepts only `.test.ts`, never `.test.mjs`. Both commands
reject missing/empty/invalid selections before running a compiler or test runner.

Keep `pnpm typecheck:server:source` as the separate all-server-tests view. It checks
all `src/__tests__` roots plus production sources and exposes the existing test
backlog; it is not the bounded affected-test command and its known failing baseline
is not a pass. It remains a separate diagnostic, not a replacement for any required
CI gate or authorization for a broad cleanup. Both compiler commands follow the
real source dependency graph. Their development-only paths resolve
the plugin SDK, runner and eval kernel from source. Most other workspace packages
already export source. It emits no JavaScript, declarations, or build cache and
does not run code generation. The runner's generated protocol source and catalog
manifests are checked in; missing or stale generated files must be repaired through
their owning generator, not replaced with stubs or partial `dist` trees. The normal
build configs, package exports and published package behavior are unchanged.

The normal server test resolver maps both the runner root and its `live` subpath
from source. This keeps the resolution regression runnable in the normal suite.
The SDK source aliases remain specific to the bounded source configuration; the
normal suite still uses its existing SDK preparation.

This check can expose existing test type errors that the production config excludes.
A nonzero result or timeout is not a pass. Report the diagnostics and their source
SHA; do not exclude failing tests or weaken strictness to hide a baseline problem.

`test:server:unit` uses the normal server test settings plus the same source entry
points as the compiler. Pass one or more existing repository-relative `.test.ts`
files under `server/src/`, or `.test.mjs` files under `server/scripts/`. An absent,
invalid, missing, directory, glob, flag, or symlink selection fails before Vitest
starts. Selection is exact, not a substring filter. It never defaults to the full
suite and does not accept Vitest flags. Pick database-free unit files for a local
check; this entry point does not make integration tests safe to run locally.
Do not select tests that require a database, browser, Docker, network service,
runner binary or workspace build output on the shared host.

Before every push, also run the changed-file formatter and linter under separate
120-second bounds, for example `nice timeout -k 10 120 pnpm exec biome format
<changed-files>` and `nice timeout -k 10 120 pnpm exec biome lint <changed-files>`.
Record the input SHA (and dirty diff when applicable), selected files, command,
elapsed time, exit result, test counts and legitimate skips. Full suites,
repo-wide type-checks, production builds, browser/integration checks and historical
mutation verification remain GitHub Actions-only; link the runs at the exact PR
head. Never substitute these bounded checks for required CI.

On the fork, `server-source-checks.yml` checks the exact PR head after a fresh
frozen, ignore-scripts install with no restored store. It checks for workspace
`dist` before and after these bounded commands. It includes the ownership-route
acceptance file and the pool-target compatibility file whenever that file exists
at the tested head. The latter is absent at the initial tooling base; absence is
reported, never counted as coverage. The negative controls include the historical
`Boolean(details)` nullable-narrowing expression that caused TS18047, selected and
transitively imported test errors, a production-root error, and missing source.
These are mechanism regressions, not a claim that the entire historical revisions
or the absent pool-target test were checked. Historical-revision verification
requires separate source-only Actions evidence when feasible.

After verification, remove only the scratch cache and `node_modules` directories
you created in your own worktree. Do not remove a pre-existing install or a shared
cache. These commands create no package `dist`, generated source, or build cache
that needs cleanup.

### Tests Must Pass

All tests must pass before a PR can be merged. Run them locally first and verify CI is green after pushing.

### Telemetry Changes

This repo has three separate data paths: Telemetry, Observability, and the run log. See rule 7 in `AGENTS.md` for the full definitions and the review level each path needs.

If your change adds, removes, or modifies emitted telemetry events, update the [Telemetry Data Contract](packages/shared/src/telemetry/README.md) in the same PR. Keep clients emitting raw dimension values and avoid documenting or relying on private delivery details. If your change adds, removes, or modifies an OpenTelemetry span or span attribute, keep the change inside the closed span-attribute allowlist in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`. If your change adds or modifies a run-log event, update `doc/run-log-events.md` in the same PR.

### Paperclip Gates Must Pass

All Paperclip CI gates (lint, typecheck, tests, build, and any other required checks) must be satisfied before a PR can be merged. Don't ask for a merge while gates are red — fix them first.

### Greptile Review

We use [Greptile](https://greptile.com) for automated code review. Your PR must achieve a **5/5 Greptile score** before it can be merged, with:

- **No open P2 (or higher) comments**
- **No open recommendations**
- **No open follow-ups**

We hold the bar high here on purpose — we want code quality to be as high as possible. If Greptile leaves comments, fix them (or, if a comment is wrong, reply explaining why) and request a re-review.

## Helping Other Contributors

Fixing up someone else's stalled or almost-there PR is **strongly encouraged**. If a contributor has done most of the work but ran out of time or got stuck, picking up their branch, polishing it, and getting it over the line is one of the most valuable things you can do here.

When you do:

- Give credit. Mention the original author in the PR description and thank them.
- Preserve their commits where reasonable — don't squash them out of existence.
- Be kind in comments and reviews. People put real effort into their PRs, even the ones that didn't quite land.

A culture where contributors help each other ship is worth more than any single PR. Be generous with thanks.

## Feature Contributions

We actively manage the core Paperclip feature roadmap.

Uncoordinated feature PRs against the core product may be closed, even when the implementation is thoughtful and high quality. That is about roadmap ownership, product coherence, and long-term maintenance commitment, not a judgment about the effort.

If you want to contribute a feature:

- Check [ROADMAP.md](ROADMAP.md) first
- Start the discussion in Discord -> `#dev` before writing code
- If the idea fits as an extension, prefer building it with the [plugin system](doc/plugins/PLUGIN_SPEC.md)
- If you want to show a possible direction, reference implementations are welcome as feedback, but they generally will not be merged directly into core

Bugs, docs improvements, and small targeted improvements are still the easiest path to getting merged, and we really do appreciate them.

## General Rules (both paths)

- Write clear commit messages
- Keep PR title + description meaningful
- One PR = one logical change (unless it's a small related group)
- Run tests locally first
- Be kind in discussions 😄

## Writing a Good PR message

Write all PR text in Simplified Technical English (ASD-STE100): use short sentences, one instruction per sentence, simple approved vocabulary, and the active voice.

Your PR description must follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md). All sections are required. The "thinking path" at the top explains from the top of the project down to what you fixed. E.g.:

### Thinking Path Example 1:

> - Paperclip is the open source app people use to manage AI agents for work
> - There are many types of adapters for each LLM model provider
> - But LLM's have a context limit and not all agents can automatically compact their context
> - So we need to have an adapter-specific configuration for which adapters can and cannot automatically compact their context
> - This pull request adds per-adapter configuration of compaction, either auto or paperclip managed
> - That way we can get optimal performance from any adapter/provider in Paperclip

### Thinking Path Example 2:

> - Paperclip is the open source app people use to manage AI agents for work
> - But humans want to watch the agents and oversee their work
> - Human users also operate in teams and so they need their own logins, profiles, views etc.
> - So we have a multi-user system for humans
> - But humans want to be able to update their own profile picture and avatar
> - But the avatar upload form wasn't saving the avatar to the file storage system
> - So this PR fixes the avatar upload form to use the file storage service
> - The benefit is we don't have a one-off file storage for just one aspect of the system, which would cause confusion and extra configuration

Then have the rest of your normal PR message after the Thinking Path.

This should include details about what you did, why you did it, why it matters & the benefits, how we can verify it works, and any risks.

Questions? Just ask in #dev — we're happy to help.

Happy hacking!
