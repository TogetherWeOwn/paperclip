/**
 * Credential-to-destination scoping acceptance tests: launch guidance (T6).
 *
 * M3 is advisory: the credential rules live in the shared Paperclip skill and
 * must actually load into every prompt bundle. T6.1/T6.2 pin the required rule
 * text (B3) and FAIL until it lands; T6.3/T6.4 pin bundle fail-closed and
 * content-addressing behavior as controls. Synthetic fixtures only. Builder
 * adds the B3 text without editing this file.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareClaudePromptBundle } from "./prompt-cache.js";

const REPO_SKILL_MD = new URL("../../../../../skills/paperclip/SKILL.md", import.meta.url);

describe("prompt-bundle credential guidance", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function readSkillAuthentication(): Promise<string> {
    const skill = await readFile(REPO_SKILL_MD, "utf8");
    const authStart = skill.indexOf("## Authentication");
    expect(authStart).toBeGreaterThanOrEqual(0);
    const nextSection = skill.indexOf("\n## ", authStart + 1);
    return nextSection === -1 ? skill.slice(authStart) : skill.slice(authStart, nextSection);
  }

  it("T6.1: the Paperclip skill forbids substituting a Paperclip credential for GitHub auth", async () => {
    const authentication = await readSkillAuthentication();
    expect(authentication).toMatch(
      /must not[^.\n]*(substitut|use[^.\n]*(instead of|for))[^.\n]*(paperclip|run|bridge)[^.\n]*(credential|token|key|jwt)[^.\n]*(github|git[^h])/i,
    );
  });

  it("T6.2: the Paperclip skill forbids forwarding credentials to unapproved origins", async () => {
    const authentication = await readSkillAuthentication();
    expect(authentication).toMatch(/must not[^.\n]*forward[^.\n]*(credential|token|key|secret|authorization)/i);
    expect(authentication).toMatch(/(unapproved|untrusted|non-paperclip|foreign|allowlist)/i);
  });

  it("T6.3: a bundle whose skill source is missing fails closed instead of launching unguided", async () => {
    await expect(
      prepareClaudePromptBundle({
        companyId: "company-scoping-test",
        skills: [
          {
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: path.join(os.tmpdir(), "paperclip-scoping-missing-skill-source"),
            sourceStatus: "missing",
          },
        ],
        instructionsContents: null,
        onLog: async () => {},
      }),
    ).rejects.toThrow();
  });

  it("T6.4: the bundle mounts the skill and content-addresses SKILL.md into the bundle key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-bundle-guidance-"));
    cleanupDirs.push(root);
    const skillDir = path.join(root, "paperclip");
    await mkdir(skillDir, { recursive: true });
    const entry = {
      key: "paperclipai/paperclip/paperclip",
      runtimeName: "paperclip",
      source: skillDir,
    };

    await writeFile(path.join(skillDir, "SKILL.md"), "# Paperclip Skill\n\n## Authentication\n\nRule set A.\n", "utf8");
    const first = await prepareClaudePromptBundle({
      companyId: "company-scoping-test",
      skills: [entry],
      instructionsContents: null,
      onLog: async () => {},
    });
    cleanupDirs.push(first.rootDir);
    const mountedSkill = await readFile(
      path.join(first.rootDir, ".claude", "skills", "paperclip", "SKILL.md"),
      "utf8",
    );
    expect(mountedSkill).toContain("Rule set A.");

    await writeFile(path.join(skillDir, "SKILL.md"), "# Paperclip Skill\n\n## Authentication\n\nRule set B.\n", "utf8");
    const second = await prepareClaudePromptBundle({
      companyId: "company-scoping-test",
      skills: [entry],
      instructionsContents: null,
      onLog: async () => {},
    });
    cleanupDirs.push(second.rootDir);
    expect(second.bundleKey).not.toBe(first.bundleKey);
    const remountedSkill = await readFile(
      path.join(second.rootDir, ".claude", "skills", "paperclip", "SKILL.md"),
      "utf8",
    );
    expect(remountedSkill).toContain("Rule set B.");
  });
});
