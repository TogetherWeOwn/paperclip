import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
    /ref: 1c9e91681fd2124e2866b9d96c3512d0171e71b7/,
  );
  assert.match(
    workflow,
    /TRUSTED_POLICY_PIN: 1c9e91681fd2124e2866b9d96c3512d0171e71b7/,
  );
  assert.match(caller, /TogetherWeOwn\/paperclip\/\.github\/workflows\/pr-trusted\.yml@[0-9a-f]{40}/);
});
