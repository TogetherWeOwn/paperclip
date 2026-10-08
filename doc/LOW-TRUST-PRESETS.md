# Low-Trust Presets

Paperclip ships core trust preset names so containment decisions are enforced in
Community Edition even when EE policy editing is unavailable.

## Presets

- `standard`: the default V1 company-visible collaboration model. This preserves
  existing behavior for normal agents.
- `low_trust_review`: an opt-in containment preset for automated work that may
  consume hostile or prompt-injected input, such as untrusted pull requests,
  external tickets, dependency diffs, or generated review output.

## Boundary Model

`low_trust_review` is resolved from existing JSON policy fields:

- agent permissions: `permissions.trustPreset` and
  `permissions.authorizationPolicy.trustBoundary`
- project policy:
  `executionWorkspacePolicy.authorizationPolicy.trustBoundary`
- issue/run policy: `executionPolicy.authorizationPolicy.trustBoundary`

The resolver intersects those sources. Narrower wins. A low-trust preset must
resolve to a concrete company-local project, root issue, or issue-id scope. If a
policy source names another company, uses an unsupported preset, or lacks that
scope for risky access, Paperclip fails closed.

## Containment, Not Privacy

This is containment for hostile automated work. It is not a general project,
issue, or human privacy system.

V1 standard work remains company-visible by default: board users and in-company
actors can inspect company work objects unless a separate access-control feature
changes that behavior. Low-trust containment instead limits what the low-trust
agent can read or mutate through the Paperclip API and prevents raw untrusted
output from being automatically promoted into higher-trust agent context.

Low-trust agents cannot read or mutate agent configuration, instruction bundles,
or company skill configuration through direct grants. Configuration changes from
low-trust work must go through higher-trust review and promotion paths instead.

## Child→Parent Reporting Under Containment

The direct-parent report comment (`doc/execution-semantics.md` §6, "Child→Parent
Reporting") is **off by default** for `low_trust_review`: a contained run reads
untrusted input, so a free-prose comment into the higher-trust parent thread is
a prompt-injection promotion path. Contained reviewers report by completing
their own review issue (`done` — the verdict is the deliverable; the
`issue_blockers_resolved` wake carries it upward) and by the platform's
system-attributed stop-only relay when they enter `blocked` or `cancelled`.
Never instruct a contained delegate to comment on its parent issue.

## Closing a Blocked Low-Trust Card

Moving a card out of `blocked` needs explicit resume authority, which a
low-trust card denies. Terminal-run recovery parks a failed low-trust review
card in `blocked`, so the one transition below is allowed through
`PATCH /issues/:id`:

- the actor is an agent **and** the card's current assignee;
- the card is `blocked` and the target status is `done` or `cancelled`.

Everything else out of `blocked` stays denied for a low-trust actor: any other
target status, `reopen`, `resume`, `blockedByIssueIds`, and any card the actor
is not assigned to. The remaining resume checks (pause hold, unresolved
blockers) still apply, and an invalid trust policy still fails closed. This adds
no capability: a low-trust assignee can already move an `in_progress` card to
`done`.

## Runtime Containment

Managed `low_trust_review` runs fail closed unless Paperclip can enforce the
runtime boundary:

- the selected execution environment must use the `sandbox` driver
- the effective execution workspace mode must be `isolated_workspace`
- the issue being run must be inside the resolved low-trust boundary
- secret references must use binding ids explicitly allowed by the boundary
- inline sensitive environment values such as API keys and tokens are rejected
- workspace runtime-service mutations are denied unless the boundary explicitly
  grants the `runtime.manage` tool class

### Designating a low-trust sandbox

Environment selection is agent default, then instance default, then local. It
does not look at the trust preset by itself, so a low-trust run on an agent with
no sandbox binding would land on local and be refused. To give low-trust runs a
sandbox without binding any agent or moving the instance default, an instance
admin designates one with `PATCH /api/instance/settings/general`:

```json
{ "lowTrustSandboxEnvironmentId": "<sandbox environment id>" }
```

Send `null` to clear it. The environment must be an active `sandbox`-driver
environment that does not reuse leases (`reuseLease` off, so no VM is kept
between runs) and is not the probe-only `fake` provider. Behavior:

- only a run whose trust preset resolves to `low_trust_review` reads it, and only
  when its selection would otherwise land on local; trusted runs never move
- an agent or instance default that already points at a non-local environment
  keeps it
- it is checked again at run time (active, `sandbox` driver, `reuseLease` off,
  not bound to another company). An unusable designation is logged and ignored
- with no usable designation the run fails with
  `low_trust_requires_sandbox_environment`, exactly as before

Deleting or archiving the designated environment therefore fails low-trust runs
closed; it never falls back to local. Clear the setting first.

The email-inbox setup check uses the same selection, so a low-trust agent whose
runs would use the designation is reported ready.

The Docker workflow in `doc/UNTRUSTED-PR-REVIEW.md` remains useful for manual
local review, but Paperclip-managed low-trust execution requires a sandboxed
environment instead of a host-local adapter process.
