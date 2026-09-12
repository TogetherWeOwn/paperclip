import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommits, COMPANY_COAUTHOR } from '../check-commit-attribution.mjs';

const valid = {
  sha: 'abc123',
  message: `fix(policy): reject false attribution\n\n${COMPANY_COAUTHOR}`,
  author: { name: 'Rick7C2', email: 'rick.dugger@gmail.com' },
  committer: { name: 'TogetherWeOwn', email: '319968614+togetherweown[bot]@users.noreply.github.com' },
};

test('allows canonical company attribution', () => {
  assert.deepEqual(checkCommits([valid]), { passed: true, failures: [] });
});

test('rejects missing, duplicate, and alternate co-author trailers', () => {
  for (const message of [
    'fix(policy): missing trailer',
    `${valid.message}\n${COMPANY_COAUTHOR}`,
    'fix(policy): wrong trailer\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>',
  ]) assert.equal(checkCommits([{ ...valid, message }]).passed, false);
});

test('rejects unapproved author identity', () => {
  assert.equal(checkCommits([{ ...valid, author: { name: 'Other', email: 'other@example.com' } }]).passed, false);
});

test('rejects internal sign-off unless DCO is enabled', () => {
  const commit = { ...valid, message: `${valid.message}\nSigned-off-by: Rick7C2 <rick.dugger@gmail.com>` };
  assert.equal(checkCommits([commit]).passed, false);
  assert.equal(checkCommits([commit], { dcoRequired: true }).passed, true);
});

test('preserves an explicit dependency/upstream authorship exception', () => {
  const upstream = { ...valid, author: { name: 'Upstream Person', email: 'person@example.org' }, message: 'vendor: import upstream release' };
  assert.equal(checkCommits([upstream], { allowPreservedAuthorship: true }).passed, true);
});

test('still rejects model/vendor tool identities under an exception', () => {
  const falseCredit = { ...valid, author: { name: 'Claude', email: 'noreply@anthropic.com' } };
  assert.equal(checkCommits([falseCredit], { allowPreservedAuthorship: true }).passed, false);
});
