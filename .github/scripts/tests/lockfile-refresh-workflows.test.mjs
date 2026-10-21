import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflows = [
  '.github/workflows/refresh-lockfile.yml',
  '.github/workflows/pr-trusted.yml',
  '.github/workflows/docker.yml',
];

test('lockfile refresh covers each base branch with its own head', async () => {
  // Port of the refresh-file half of the master contract test (#217). The
  // pr-trusted assertions do not port: trusted policy executes from @master
  // (pr.yml pins pr-trusted.yml@master), so only the refresh wiring runs from
  // this branch's copy. A push executes the workflow file on the pushed
  // branch, so this live deploy/tog6 copy is the one that must pin the
  // per-branch trigger, head, concurrency group, and --base targeting.
  const refresh = await readFile('.github/workflows/refresh-lockfile.yml', 'utf8');

  // Triggered for master and the deploy/tog6 release line, serialized per branch.
  assert.match(refresh, /- master/);
  assert.match(refresh, /- deploy\/tog6/);
  assert.match(refresh, /group: refresh-lockfile-\$\{\{ github\.ref_name \}\}/);

  // One head per base: the master head is force-pushed on every master
  // refresh, so it must never be reused for another base.
  assert.match(refresh, /master\) BRANCH="chore\/refresh-lockfile" ;;/);
  assert.match(refresh, /deploy\/tog6\) BRANCH="chore\/refresh-lockfile-deploy-tog6" ;;/);

  // The refresh PR targets the pushed branch, not the default branch. Both
  // the reuse lookup (gh pr list) and the creation (gh pr create) must carry
  // --base; the create call is asserted directly so a revert there cannot
  // hide behind the identical string on the list call.
  const baseOccurrences = refresh.match(/--base "\$BASE_BRANCH"/g) ?? [];
  assert.equal(baseOccurrences.length, 2);
  assert.match(refresh, /gh pr create [\s\S]*?--base "\$BASE_BRANCH"/);

  // Unsupported dispatch branches fail closed instead of refreshing onto the
  // wrong head.
  assert.match(
    refresh,
    /\*\)\n\s*echo "Lockfile refresh does not support branch: \$BASE_BRANCH"\n\s*exit 1/
  );
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
