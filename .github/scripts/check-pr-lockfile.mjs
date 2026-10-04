#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Admits a pnpm-lock.yaml hunk only when it is regenerable from the PR's
 * manifests. The hard byte-identity check runs in the
 * `Block unregenerable lockfile edits` policy step in pr-trusted.yml; this
 * comment-gate admits the same shape cheaply (lockfile + a package.json in
 * the file list) so authors get guidance instead of a hard-fail surprise,
 * and keeps blocking lockfile-only hunks with no manifest change.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

export function checkLockfile(files, prAuthor, prBranch) {
  const names = files.map(f => f.filename);
  const lockfileChanged = names.includes('pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBot =
    prAuthor === 'github-actions[bot]' && prBranch === 'chore/refresh-lockfile';
  if (isRefreshBot) return { passed: true, failures: [] };

  const manifestChanged = names.some(n => /(^|\/)package\.json$/.test(n));
  if (manifestChanged) return { passed: true, failures: [] };

  return {
    passed: false,
    failures: [
      'You have changes to `pnpm-lock.yaml` with no `package.json` change in this PR. ' +
      'The `Block unregenerable lockfile edits` policy step will fail unless the lockfile hunk ' +
      'is exactly what `pnpm install` regenerates from the PR manifests. ' +
      'To fix: run `pnpm install` locally and commit the regenerated lockfile alongside the ' +
      'manifest change, or drop the lockfile hunk — the lockfile is regenerated automatically ' +
      'by the refresh bot on a schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
