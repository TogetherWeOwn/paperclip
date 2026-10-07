import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment, publishQualityGateComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

test('publishQualityGateComment: no-comment mode skips comment reads and writes', async () => {
  let reads = 0;
  let writes = 0;

  await publishQualityGateComment({
    noComment: true,
    fetchFromGitHub: async () => { reads += 1; return []; },
    postComment: async () => { writes += 1; },
    token: 'token',
    repo: 'paperclipai/paperclip',
    prNumber: 6469,
    author: 'contributor',
    failures: ['Missing verification'],
    informational: [],
  });

  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('publishQualityGateComment: default mode posts failures', async () => {
  const reads = [];
  const writes = [];

  await publishQualityGateComment({
    fetchFromGitHub: async path => { reads.push(path); return []; },
    postComment: async (...args) => { writes.push(args); },
    token: 'token',
    repo: 'paperclipai/paperclip',
    prNumber: 6469,
    author: 'contributor',
    failures: ['Missing verification'],
    informational: [],
  });

  assert.deepEqual(reads, ['/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'token');
  assert.equal(writes[0][3].includes('Missing verification'), true);
  assert.equal(writes[0][4], null);
});
