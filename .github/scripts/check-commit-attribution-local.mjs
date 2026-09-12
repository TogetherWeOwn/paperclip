#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { checkCommits } from './check-commit-attribution.mjs';

const message = await readFile(process.env.COMMIT_MESSAGE_FILE, 'utf8');
const result = checkCommits([{
  sha: 'new commit',
  message,
  author: { name: process.env.GIT_AUTHOR_NAME ?? '', email: process.env.GIT_AUTHOR_EMAIL ?? '' },
  committer: { name: process.env.GIT_COMMITTER_NAME ?? '', email: process.env.GIT_COMMITTER_EMAIL ?? '' },
}], { dcoRequired: process.env.DCO_REQUIRED === 'true' });
for (const failure of result.failures) console.error(`ERROR: ${failure}`);
process.exit(result.passed ? 0 : 1);
