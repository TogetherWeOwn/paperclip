import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflow = await readFile(new URL('../../workflows/pr-trusted.yml', import.meta.url), 'utf8');
const caller = await readFile(new URL('../../workflows/pr.yml', import.meta.url), 'utf8');

const policyCheckout = workflow.match(
  /- name: Checkout trusted attribution policy\n([\s\S]*?)(?=\n\s{6}- name:)/,
)?.[1] ?? '';
const policyEnforcement = workflow.match(
  /- name: Enforce trusted pull request and commit policy\n([\s\S]*?)(?=\n\s{6}- name:)/,
)?.[1] ?? '';

test('declares an explicit required least-privilege credential contract', () => {
  assert.match(workflow, /workflow_call:\n\s+secrets:\n\s+TRUSTED_POLICY_TOKEN:/);
  assert.match(workflow, /description: Read-only installation token scoped to TogetherWeOwn\/paperclip-ops-tooling\./);
  assert.match(workflow, /required: true/);
  assert.match(workflow, /TRUSTED_POLICY_TOKEN is required/);
  assert.match(workflow, /github_pat_\*\|ghs_\*/);
  assert.match(workflow, /invalid installation-token shape/);
});

test('checks out only immutable trusted checker code with the credential', () => {
  assert.match(policyCheckout, /repository: TogetherWeOwn\/paperclip-ops-tooling/);
  assert.match(policyCheckout, /ref: [0-9a-f]{40}/);
  assert.match(policyCheckout, /path: trusted-policy/);
  assert.match(policyCheckout, /token: \$\{\{ secrets\.TRUSTED_POLICY_TOKEN \}\}/);
  assert.match(policyCheckout, /persist-credentials: false/);
  assert.doesNotMatch(policyCheckout, /pull-request/);
  assert.doesNotMatch(workflow, /token: \$\{\{ secrets\.TRUSTED_POLICY_TOKEN \}\}[\s\S]*path: pull-request/);
});

test('passes trusted event and commit facts to the trusted runner, not caller classifications', () => {
  assert.match(policyEnforcement, /working-directory: \./);
  assert.match(policyEnforcement, /TRUSTED_EVENT_JSON: \$\{\{ toJSON\(github\.event\) \}\}/);
  assert.match(policyEnforcement, /TRUSTED_EVENT_ACTION: \$\{\{ github\.event\.action \}\}/);
  assert.match(policyEnforcement, /TRUSTED_EVENT_SENDER_ID: \$\{\{ github\.event\.sender\.id \}\}/);
  assert.match(policyEnforcement, /printf '%s' "\$TRUSTED_EVENT_JSON" > "\$event_file"/);
  assert.match(policyEnforcement, /node trusted-policy\/github_policy_ci\.mjs "\$event_file" pull-request/);
  assert.doesNotMatch(policyEnforcement, /ATTRIBUTION_EXCEPTION|DCO_REQUIRED|TOPOLOGY_EXCEPTION/);
  assert.doesNotMatch(policyEnforcement, /secrets\.|TRUSTED_POLICY_TOKEN/);
});

test('covers metadata edits and rejects checker substitution paths', () => {
  assert.match(caller, /pull_request:\n\s+types: \[opened, reopened, synchronize, edited\]/);
  assert.match(workflow, /opened\|reopened\|synchronize\|edited/);
  assert.doesNotMatch(workflow, /node \.github\/scripts\/check-pr-commit-attribution\.mjs/);
  assert.doesNotMatch(policyEnforcement, /pull-request\/.*github_policy/);
});

test('pins the reusable workflow and corrected trusted checker by immutable SHA', () => {
  assert.match(
    workflow,
    /ref: bbe53af536017fa3509f869dc7ff7feb76e8cb3f/,
  );
  assert.match(
    workflow,
    /TRUSTED_POLICY_PIN: bbe53af536017fa3509f869dc7ff7feb76e8cb3f/,
  );
  assert.match(caller, /TogetherWeOwn\/paperclip\/\.github\/workflows\/pr-trusted\.yml@[0-9a-f]{40}/);
});

test('the caller actually resolves to a commit whose checker pin is corrected', () => {
  // TOG-2390: a caller SHA can be "some 40-hex string" while still pointing at
  // the pre-fix pr-trusted.yml — the earlier version of this test only checked
  // the shape of the pin, not what it resolves to. Fetch the exact blob the
  // caller's immutable ref names and assert the checker ref/pin it contains
  // are the corrected values, not the vulnerable ones.
  const callerRef = caller.match(
    /uses: TogetherWeOwn\/paperclip\/\.github\/workflows\/pr-trusted\.yml@([0-9a-f]{40})/,
  )?.[1];
  assert.ok(callerRef, 'caller must pin pr-trusted.yml to a 40-hex SHA');

  const resolvedWorkflow = execFileSync(
    'git',
    ['-C', repoRoot, 'show', `${callerRef}:.github/workflows/pr-trusted.yml`],
    { encoding: 'utf8' },
  );

  assert.match(
    resolvedWorkflow,
    /ref: bbe53af536017fa3509f869dc7ff7feb76e8cb3f/,
    `caller pin ${callerRef} must resolve to a pr-trusted.yml with the corrected checkout ref`,
  );
  assert.match(
    resolvedWorkflow,
    /TRUSTED_POLICY_PIN: bbe53af536017fa3509f869dc7ff7feb76e8cb3f/,
    `caller pin ${callerRef} must resolve to a pr-trusted.yml with the corrected TRUSTED_POLICY_PIN`,
  );
  assert.doesNotMatch(
    resolvedWorkflow,
    /3552145dbb3e57bd5d65e18025d9ab737019d550/,
    `caller pin ${callerRef} must not resolve to a pr-trusted.yml still carrying the vulnerable checker pin`,
  );
});

test('positive control: a stale caller pin is caught by the resolution check', () => {
  // Proves the previous test is not vacuous: pinning the caller to the
  // pre-fix commit (the actual TOG-2386 bypass) must fail resolution.
  const stalePin = '43cd4ff932a884fcb672d96017070b3b25e42652';
  const resolvedWorkflow = execFileSync(
    'git',
    ['-C', repoRoot, 'show', `${stalePin}:.github/workflows/pr-trusted.yml`],
    { encoding: 'utf8' },
  );
  assert.match(resolvedWorkflow, /ref: 3552145dbb3e57bd5d65e18025d9ab737019d550/);
  assert.doesNotMatch(resolvedWorkflow, /ref: bbe53af536017fa3509f869dc7ff7feb76e8cb3f/);
});
