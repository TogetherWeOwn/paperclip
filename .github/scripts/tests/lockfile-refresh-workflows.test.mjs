import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker-cloud.yml',
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

test('immutable Docker builds preserve committed dependency inputs', async () => {
  const workflow = await readFile('.github/workflows/docker.yml', 'utf8');
  const dockerfile = await readFile('Dockerfile', 'utf8');
  const controls = await readFile('scripts/ci/immutable-docker.py', 'utf8');

  assert.doesNotMatch(workflow, /pnpm install|--no-frozen-lockfile|--resolution-only/);
  assert.match(dockerfile, /RUN pnpm install --frozen-lockfile/);
  assert.match(workflow, /immutable-docker\.py prepare/);
  assert.match(workflow, /immutable-docker\.py record/);
  assert.match(controls, /"policy": "frozen-no-refresh"/);
  assert.match(controls, /"status", "--porcelain", "--untracked-files=all"/);
});
