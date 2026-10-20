import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker.yml',
];

test('lockfile refresh covers each base branch with its own head', async () => {
  const refresh = await readFile('.github/workflows/refresh-lockfile.yml', 'utf8');
  const trusted = await readFile('.github/workflows/pr-trusted.yml', 'utf8');

  // Triggered for master and the deploy/tog6 release line, serialized per branch.
  assert.match(refresh, /- master/);
  assert.match(refresh, /- deploy\/tog6/);
  assert.match(refresh, /group: refresh-lockfile-\$\{\{ github\.ref_name \}\}/);

  // One head per base: the master head is force-pushed on every master
  // refresh, so it must never be reused for another base.
  assert.match(refresh, /master\) BRANCH="chore\/refresh-lockfile" ;;/);
  assert.match(refresh, /deploy\/tog6\) BRANCH="chore\/refresh-lockfile-deploy-tog6" ;;/);

  // The refresh PR targets the pushed branch, not the default branch.
  assert.match(refresh, /--base "\$BASE_BRANCH"/);

  // The trusted policy exempts both bot heads from the manual-edit block.
  assert.match(trusted, /github\.head_ref != 'chore\/refresh-lockfile' &&/);
  assert.match(trusted, /github\.head_ref != 'chore\/refresh-lockfile-deploy-tog6' &&/);
});

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
