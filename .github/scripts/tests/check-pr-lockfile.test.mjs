import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

test('passes when lockfile changed alongside a workspace manifest', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml', 'cli/package.json']),
    'someuser',
    'feat/add-dep'
  );
  assert.equal(result.passed, true);
});

test('passes when lockfile changed alongside the root manifest', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml', 'package.json']),
    'someuser',
    'feat/add-dep'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed with no manifest (guidance mentions regen gate)', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('Block unregenerable lockfile edits'));
});
