#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { checkCommits } from './check-commit-attribution.mjs';

const [baseSha, headSha] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(baseSha ?? '') || !/^[0-9a-f]{40}$/.test(headSha ?? '')) {
  console.error('Usage: check-pr-commit-attribution.mjs <base-sha> <head-sha>');
  process.exit(2);
}

const recordSeparator = '\x1e';
const fieldSeparator = '\x1f';
const output = execFileSync('git', [
  'log',
  '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e',
  `${baseSha}..${headSha}`,
], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const commits = output.split(recordSeparator).filter((record) => record.trim()).map((record) => {
  const [sha, authorName, authorEmail, committerName, committerEmail, ...message] = record.replace(/^\n/, '').split(fieldSeparator);
  return {
    sha,
    message: message.join(fieldSeparator).trimEnd(),
    author: { name: authorName, email: authorEmail },
    committer: { name: committerName, email: committerEmail },
  };
});
const result = checkCommits(commits, { dcoRequired: process.env.DCO_REQUIRED === 'true' });
for (const failure of result.failures) console.error(`ERROR: ${failure}`);
process.exit(result.passed ? 0 : 1);
