import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideGroup,
  isMirrorBaseRef,
  readHeadGroups,
} from "../resolve-general-group.mjs";

const OLDER_HEAD_GROUPS = [
  "general-server",
  "general-chat",
  "general-workspaces-a",
  "general-workspaces-b",
];
const MIRROR_BASE = "mirror/base-ba04968b1";

function fixtureHead(runnerSource) {
  const root = mkdtempSync(join(tmpdir(), "resolve-general-group-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "run-vitest-stable.mjs"), runnerSource);
  return root;
}

function dryRunSource(groups) {
  return `console.log(JSON.stringify({ mode: 'general', availableGeneralGroups: ${JSON.stringify(groups)} }));\n`;
}

test("recognizes upstream mirror base branches and nothing else", () => {
  assert.equal(isMirrorBaseRef("mirror/base-ba04968b1"), true);
  assert.equal(isMirrorBaseRef("mirror-base/14390-6c36c07a"), true);
  assert.equal(isMirrorBaseRef("mirror/upstream-15158-base"), true);
  assert.equal(isMirrorBaseRef("master"), false);
  assert.equal(isMirrorBaseRef("feat/mirror-notes"), false);
  assert.equal(isMirrorBaseRef(""), false);
});

test("mirror PR skips a group its head does not define, with an explicit skip message", () => {
  const decision = decideGroup({
    baseRef: MIRROR_BASE,
    group: "general-workspaces-c",
    probe: { ok: true, groups: OLDER_HEAD_GROUPS },
  });

  assert.equal(decision.run, false);
  assert.equal(
    decision.message,
    "PR head does not define general-workspaces-c; skipped, not passed",
  );
});

test("mirror PR runs a group its head defines", () => {
  const decision = decideGroup({
    baseRef: MIRROR_BASE,
    group: "general-chat",
    probe: { ok: true, groups: OLDER_HEAD_GROUPS },
  });

  assert.equal(decision.run, true);
});

test("mirror PR runs the group when the head group list cannot be read", () => {
  const decision = decideGroup({
    baseRef: MIRROR_BASE,
    group: "general-chat",
    probe: { ok: false, error: 'Unknown argument "--dry-run".' },
  });

  assert.equal(decision.run, true);
  assert.match(decision.message, /unreadable/);
});

test("ordinary PR never skips a group, even one the head does not define", () => {
  const decision = decideGroup({
    baseRef: "master",
    group: "general-workspaces-c",
    probe: { ok: true, groups: OLDER_HEAD_GROUPS },
  });

  assert.equal(decision.run, true);
});

test("reads the group list from a head script that predates the newer group", () => {
  const head = fixtureHead(dryRunSource(OLDER_HEAD_GROUPS));
  try {
    const probe = readHeadGroups(head);

    assert.deepEqual(probe, { ok: true, groups: OLDER_HEAD_GROUPS });
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("mirror PR head without workspaces-c end to end skips it and runs the rest", () => {
  const head = fixtureHead(dryRunSource(OLDER_HEAD_GROUPS));
  try {
    const probe = readHeadGroups(head);

    assert.equal(
      decideGroup({
        baseRef: MIRROR_BASE,
        group: "general-workspaces-c",
        probe,
      }).run,
      false,
    );
    assert.equal(
      decideGroup({
        baseRef: MIRROR_BASE,
        group: "general-workspaces-a",
        probe,
      }).run,
      true,
    );
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("reports an unreadable head when the runner script rejects --dry-run", () => {
  const head = fixtureHead(
    "console.error('Unknown argument \"--dry-run\".');\nprocess.exit(1);\n",
  );
  try {
    const probe = readHeadGroups(head);

    assert.equal(probe.ok, false);
    assert.match(probe.error, /Command failed/);
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});

test("reports an unreadable head when the dry-run output has no group list", () => {
  const head = fixtureHead(
    "console.log(JSON.stringify({ mode: 'general' }));\n",
  );
  try {
    assert.deepEqual(readHeadGroups(head), {
      ok: false,
      error: "dry-run output has no availableGeneralGroups",
    });
  } finally {
    rmSync(head, { recursive: true, force: true });
  }
});
