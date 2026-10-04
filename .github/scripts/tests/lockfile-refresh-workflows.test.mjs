import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker.yml',
];

test('lockfile repair workflows resolve dependencies instead of updating metadata only', async () => {
  for (const workflow of workflows) {
    const contents = await readFile(workflow, 'utf8');
    const repairCommands = contents
      .split('\n')
      .filter((line) => line.includes('pnpm install') && line.includes('--no-frozen-lockfile'));

    assert.ok(repairCommands.length > 0, `${workflow} must contain a lockfile repair command`);
    for (const command of repairCommands) {
      assert.match(command, /--resolution-only/);
      assert.match(command, /--ignore-scripts/);
      assert.doesNotMatch(command, /--lockfile-only/);
    }
  }
});

test('policy gate admits regenerable lockfile hunks and still blocks hand-edits', async () => {
  const contents = await readFile('.github/workflows/pr-trusted.yml', 'utf8');
  // The old blanket ban must be gone.
  assert.doesNotMatch(contents, /Block manual lockfile edits/);
  assert.doesNotMatch(contents, /Do not commit pnpm-lock\.yaml in pull requests/);
  // The amended gate must exist and enforce regen-identity.
  assert.match(contents, /Block unregenerable lockfile edits/);
  assert.match(contents, /package\\.json\$/);
  assert.match(contents, /--resolution-only/);
  assert.match(contents, /cmp -s pnpm-lock\.yaml/);
  assert.ok(contents.indexOf('      - name: Setup pnpm\n') < contents.indexOf('      - name: Block unregenerable lockfile edits\n'));
  assert.match(contents, /trap .* EXIT/);
});
