import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { affectedWork } from '../../../scripts/ci-affected-work.mjs';

const workflow = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const heavyJobs = ['typecheck_release_registry', 'general_tests', 'docker_context_integrity', 'verify_paperclip_runner', 'build', 'verify_serialized_server', 'canary_dry_run', 'e2e_shards'];

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name}`);
  return workflow.slice(start).split(/\n  [a-z][a-z0-9_-]*:\n/)[1];
}

function script(name) {
  return job(name).split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
}

function run(name, env) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script(name)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  }).status;
}

test('documentation-only PRs omit heavy work, but non-PR runs remain full', () => {
  assert.equal(affectedWork('pull_request', 'pr', ['doc/DEVELOPING.md', 'README.md']), false);
  for (const event of ['push', 'schedule', 'workflow_dispatch', 'workflow_call']) {
    assert.equal(affectedWork(event, 'pr', ['doc/DEVELOPING.md']), true);
  }
});

test('dependency, lockfile, patches, and GitHub changes invalidate every scope', () => {
  const globalPaths = ['package.json', 'ui/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/workflows/pr-trusted.yml', 'patches/fix.patch', 'packages/runner/Cargo.lock', '.npmrc', '.pnpmfile.cjs'];
  for (const scope of ['docker', 'smoke', 'release', 'workflows', 'pr']) {
    for (const path of globalPaths) assert.equal(affectedWork('pull_request', scope, [path]), true, `${scope}: ${path}`);
  }
  assert.throws(() => affectedWork('pull_request', 'unknown', []), /Unknown CI scope/);
});

test('PR scope includes application code and root build/test configuration', () => {
  for (const path of ['server/src/app.ts', 'ui/src/App.tsx', 'cli/src/index.ts', 'packages/shared/src/index.ts', 'tests/e2e.test.ts', 'scripts/check.mjs', 'docker/compose.yml', 'Dockerfile', '.dockerignore', 'tsconfig.json', 'vitest.config.ts', 'playwright.config.ts']) {
    assert.equal(affectedWork('pull_request', 'pr', [path]), true, path);
  }
});

test('all heavy jobs use change classification without weakening runner routing', () => {
  assert.match(job('changes'), /uses: \.\/\.github\/workflows\/ci-changes\.yml/);
  assert.match(job('changes'), /scope: pr/);
  for (const name of heavyJobs) {
    assert.match(job(name), /needs: \[gate, changes\]/, name);
    assert.match(job(name), /if: \$\{\{ needs\.changes\.outputs\.affected == 'true' \}\}/, name);
    assert.match(job(name), /runs-on: \$\{\{ needs\.gate\.outputs\.runner \}\}/, name);
  }
  assert.doesNotMatch(workflow, /needs\.gate\.outputs\.full_ci/);
  const changes = readFileSync('.github/workflows/ci-changes.yml', 'utf8');
  assert.match(changes, /runs-on: ubuntu-latest/);
  assert.match(changes, /persist-credentials: false/);
  assert.match(changes, /contents: read/);
  assert.doesNotMatch(changes, /secrets: inherit/);
});

test('required verify aggregate rejects failed classification or unexpected lane skips', () => {
  const success = {
    FULL_CI: 'true', CHANGES_RESULT: 'success', POLICY_RESULT: 'success',
    TYPECHECK_RELEASE_REGISTRY_RESULT: 'success', GENERAL_TESTS_RESULT: 'success',
    RUNNER_VERIFICATION_RESULT: 'success', BUILD_RESULT: 'success', DOCKER_CONTEXT_INTEGRITY_RESULT: 'success',
  };
  assert.equal(run('verify', success), 0);
  for (const key of Object.keys(success).filter(key => key.endsWith('_RESULT'))) {
    assert.notEqual(run('verify', { ...success, [key]: 'skipped' }), 0, key);
  }
  const skipped = { ...success, FULL_CI: 'false' };
  for (const key of Object.keys(skipped).filter(key => !['CHANGES_RESULT', 'POLICY_RESULT'].includes(key) && key.endsWith('_RESULT'))) skipped[key] = 'skipped';
  assert.equal(run('verify', skipped), 0);
  assert.notEqual(run('verify', { ...skipped, FULL_CI: '' }), 0);
});

test('required e2e aggregate allows only deliberately unaffected skips', () => {
  const success = { FULL_CI: 'true', CHANGES_RESULT: 'success', POLICY_RESULT: 'success', E2E_SHARDS_RESULT: 'success' };
  assert.equal(run('e2e', success), 0);
  assert.notEqual(run('e2e', { ...success, E2E_SHARDS_RESULT: 'skipped' }), 0);
  assert.notEqual(run('e2e', { ...success, CHANGES_RESULT: 'failure' }), 0);
  assert.equal(run('e2e', { ...success, FULL_CI: 'false', E2E_SHARDS_RESULT: 'skipped' }), 0);
  assert.notEqual(run('e2e', { ...success, FULL_CI: '' }), 0);
});

test('ci-ok covers legacy required gates, serialized suites, and canary', () => {
  assert.match(job('ci-ok'), /if: \$\{\{ always\(\) \}\}/);
  for (const name of ['gate', 'changes', 'policy', 'verify', 'e2e', 'verify_serialized_server', 'canary_dry_run']) {
    assert.match(job('ci-ok'), new RegExp(`needs\\.${name}\\.result`));
  }
  const success = {
    GATE_RESULT: 'success', CHANGES_RESULT: 'success', POLICY_RESULT: 'success', VERIFY_RESULT: 'success', E2E_RESULT: 'success',
    AFFECTED: 'true', SERIALIZED_RESULT: 'success', CANARY_RESULT: 'success',
  };
  assert.equal(run('ci-ok', success), 0);
  for (const key of Object.keys(success).filter(key => key.endsWith('_RESULT'))) {
    for (const result of ['failure', 'cancelled', 'skipped']) assert.notEqual(run('ci-ok', { ...success, [key]: result }), 0, `${key} ${result}`);
  }
  const skipped = { ...success, AFFECTED: 'false', SERIALIZED_RESULT: 'skipped', CANARY_RESULT: 'skipped' };
  assert.equal(run('ci-ok', skipped), 0);
  assert.notEqual(run('ci-ok', { ...skipped, CHANGES_RESULT: 'skipped' }), 0);
  assert.notEqual(run('ci-ok', { ...skipped, AFFECTED: '' }), 0);
  assert.notEqual(run('ci-ok', { ...skipped, SERIALIZED_RESULT: 'cancelled' }), 0);
});
