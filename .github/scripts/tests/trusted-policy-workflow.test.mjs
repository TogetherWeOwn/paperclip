import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../../workflows/pr-trusted.yml', import.meta.url), 'utf8');
const caller = await readFile(new URL('../../workflows/pr.yml', import.meta.url), 'utf8');

test('checks out trusted policy separately and never invokes the PR checker copy', () => {
  assert.match(workflow, /repository: TogetherWeOwn\/paperclip-ops-tooling/);
  assert.match(workflow, /path: trusted-policy/);
  assert.match(workflow, /path: pull-request/);
  assert.match(workflow, /node \.\.\/trusted-policy\/github_policy_check\.mjs pr/);
  assert.match(workflow, /node \.\.\/trusted-policy\/github_policy_check\.mjs commit/);
  assert.doesNotMatch(workflow, /node \.github\/scripts\/check-pr-commit-attribution\.mjs/);
});

test('keeps every policy command in the pull request checkout', () => {
  assert.match(workflow, /defaults:\n\s+run:\n\s+working-directory: pull-request/);
});

test('pins both published trusted revisions by immutable SHA', () => {
  assert.match(workflow, /ref: 2585661e7c2a5be1d9d6cda26e12bc6eab8ea67e/);
  assert.match(caller, /TogetherWeOwn\/paperclip\/.github\/workflows\/pr-trusted\.yml@3f1772f2cfe60baf37fc8665375ba7953cf277f7/);
});
