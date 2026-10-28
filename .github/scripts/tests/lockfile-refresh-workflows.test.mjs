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

  // The trusted policy exempts both bot heads from the manual-edit block, and
  // only for same-repo heads: a fork can reuse the branch name, so the head
  // repository must match. The || joining the repo guard to the head-name
  // check is pinned too: flipping it to && would silently reintroduce the
  // fork bypass (and skip the step for every same-repo PR).
  assert.match(trusted, /github\.head_ref != 'chore\/refresh-lockfile' &&/);
  assert.match(trusted, /github\.head_ref != 'chore\/refresh-lockfile-deploy-tog6'/);
  assert.match(trusted, /github\.event\.pull_request\.head\.repo\.full_name != github\.repository \|\|/);
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

test('policy gate admits regenerable lockfile hunks and still blocks hand-edits', async () => {
  const contents = await readFile('.github/workflows/pr-trusted.yml', 'utf8');
  // The old blanket ban must be gone.
  assert.doesNotMatch(contents, /Block manual lockfile edits/);
  assert.doesNotMatch(contents, /Do not commit pnpm-lock\.yaml in pull requests/);
  // The amended gate must exist and enforce regen-identity.
  assert.match(contents, /Block unregenerable lockfile edits/);
  assert.match(contents, /package\.json\|\*\/package\.json\) manifest_changed=true/);
  assert.match(contents, /git diff --no-renames --name-only -z/);
  assert.doesNotMatch(contents, /printf .*\| grep -[Eqx]/);
  assert.match(contents, /--resolution-only --ignore-scripts --ignore-pnpmfile/);
  assert.match(contents, /cmp -s pnpm-lock\.yaml/);
  assert.ok(contents.indexOf('      - name: Setup pnpm\n') < contents.indexOf('      - name: Block unregenerable lockfile edits\n'));
  assert.match(contents, /trap .* EXIT/);
});
