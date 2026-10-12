import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const WORKFLOW = '.github/workflows/pr-trusted.yml';

// actions/checkout resolves `path` against GITHUB_WORKSPACE and rejects any
// location outside it, so every checkout path must stay workspace-relative.
// Regression test: the "Checkout trusted CI scripts" steps once used
// `${{ runner.temp }}/trusted-ci` (a sibling of the workspace), which would
// have failed the policy job and every General tests entry on every PR.
function checkoutPaths(workflowText) {
  const lines = workflowText.split('\n');
  const paths = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/checkout@/.test(lines[i])) continue;
    // The `with:` block follows within a few lines. `path:` (when present)
    // comes before the next step or executable key.
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const line = lines[j];
      if (/^\s*-\s*name:/.test(line) || /^\s*(run|uses):/.test(line)) break;
      const match = line.match(/^\s*path:\s*(.+?)\s*$/);
      if (match) {
        paths.push({ line: j + 1, value: match[1] });
        break;
      }
    }
  }
  return paths;
}

test('actions/checkout paths in pr-trusted.yml are workspace-relative', async () => {
  const contents = await readFile(WORKFLOW, 'utf8');
  const paths = checkoutPaths(contents);

  assert.ok(
    paths.length > 0,
    `${WORKFLOW} must contain at least one actions/checkout path for this test to guard`,
  );
  for (const { line, value } of paths) {
    assert.doesNotMatch(
      value,
      /runner\.temp/,
      `${WORKFLOW}:${line} checkout path must not use runner.temp (outside GITHUB_WORKSPACE)`,
    );
    assert.doesNotMatch(
      value,
      /^\//,
      `${WORKFLOW}:${line} checkout path must not be an absolute POSIX path, got: ${value}`,
    );
    assert.doesNotMatch(
      value,
      /^[A-Za-z]:[\\/]/,
      `${WORKFLOW}:${line} checkout path must not be an absolute Windows path, got: ${value}`,
    );
    assert.doesNotMatch(
      value,
      /^\${{/,
      `${WORKFLOW}:${line} checkout path must be a plain workspace-relative path, got: ${value}`,
    );
  }
});
