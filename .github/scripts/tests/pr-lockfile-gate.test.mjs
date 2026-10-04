import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync('.github/workflows/pr-trusted.yml', 'utf8');
const gate = workflow.split('      - name: Block unregenerable lockfile edits\n')[1]
  .split('        run: |\n')[1].split('\n      - name:')[0]
  .split('\n').map(line => line.slice(10)).join('\n');

function runGate({ manifest = true, lockfile = true, reproducible = true, resolverFails = false, lookalike = false } = {}) {
  const directory = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'lockfile-gate-'));
  try {
    const run = (...args) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    run('init', '-q');
    writeFileSync(join(directory, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'base\n');
    run('add', '.');
    run('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD');
    if (manifest) writeFileSync(join(directory, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
    if (lookalike) writeFileSync(join(directory, 'notpackage.json'), '{}\n');
    if (lockfile) writeFileSync(join(directory, 'pnpm-lock.yaml'), 'generated\n');
    writeFileSync(join(directory, 'README.md'), 'fixture\n');
    run('add', '.');
    run('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'head');
    const head = run('rev-parse', 'HEAD');
    const original = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
    const bin = join(directory, 'bin');
    const temporary = join(directory, 'temporary');
    mkdirSync(bin);
    mkdirSync(temporary);
    writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'install --resolution-only --ignore-scripts --no-frozen-lockfile' ]]
printf 'called' > resolver-called
printf '${reproducible ? 'generated' : 'different'}\\n' > pnpm-lock.yaml
exit ${resolverFails ? 42 : 0}
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', gate], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, RUNNER_TEMP: temporary, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8'), original, 'the gate must restore the committed PR lockfile');
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('gate admits a manifest change with a reproducible lockfile', () => {
  const result = runGate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Lockfile hunk verified/);
});

test('gate rejects a lockfile-only change', () => {
  const result = runGate({ manifest: false });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /without a package.json change/);
});

test('gate rejects a filename that only ends in package.json', () => {
  assert.equal(runGate({ manifest: false, lookalike: true }).status, 1);
});

test('gate rejects a manifest change with an unregenerable lockfile', () => {
  const result = runGate({ reproducible: false });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /does not match/);
});

test('gate preserves resolver failure and restores the PR lockfile', () => {
  assert.equal(runGate({ resolverFails: true }).status, 42);
});

test('gate accepts a PR with no lockfile change without invoking the resolver', () => {
  const result = runGate({ lockfile: false, resolverFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Lockfile hunk verified/);
});
