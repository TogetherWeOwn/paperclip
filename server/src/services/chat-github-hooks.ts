import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";

const hookSchema = z.record(z.string(), z.array(z.object({
  matcher: z.string().optional(),
  hooks: z.array(z.object({ type: z.literal("command"), command: z.string(), timeout: z.number().optional() }).strict()),
}).strict()));
const reviewed = ["model-guard/model-guard-hook.mjs", "muse-stop-guard/muse-stop-guard.mjs", "disposition-stop-guard/disposition-stop-guard.mjs"];

/** Only operator-owned immutable definitions are copied, never HOME or arbitrary
 * agent-supplied settings. No verdicts, counters, transcripts or credentials.
 * Unknown hooks must be reviewed before candidate execution, not silently lost.
 * The production reviewer and its configuration are never modified. */
export async function githubCandidateHooks(home: string, read = (path: string) => fs.readFile(path, "utf8")) {
  const optional = async (path: string) => {
    try { return await read(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const settings = await optional("/paperclip/.claude/settings.json");
  const hooks = hookSchema.parse(settings === null ? {} : JSON.parse(settings).hooks ?? {});
  const files: Record<string, string> = {};
  const originalDefinitions = JSON.stringify(hooks);
  for (const [event, groups] of Object.entries(hooks)) for (const group of groups) for (const hook of group.hooks) {
    const source = reviewed.find(path => hook.command === `node /paperclip/${path}`);
    if (!source || !["PreToolUse", "Stop"].includes(event)) throw new Error("github_candidate_hooks_unreviewed");
    files[`hooks/${source}`] = await read(`/paperclip/${source}`);
    const directory = source.split("/")[0]!;
    for (const name of [`${directory}.config.json`, "DISABLED"]) {
      const content = await optional(`/paperclip/${directory}/${name}`);
      if (content !== null) files[`hooks/${directory}/${name}`] = content;
    }
    // This hook reads the issue API, which candidates deliberately cannot use.
    // In observe/disabled mode it cannot veto or change a review. Do not silently
    // certify parity if an operator later turns enforcement on.
    if (directory === "disposition-stop-guard" && files[`hooks/${directory}/DISABLED`] === undefined) {
      const config = files[`hooks/${directory}/${directory}.config.json`];
      if (!config || JSON.parse(config).mode !== "observe") throw new Error("github_candidate_disposition_hook_not_observational");
    }
    hook.command = `node ${home}/hooks/${source}`;
  }
  // Digest is independent of run namespace but covers original definitions,
  // executable bytes and tuning/disabled state. Each run records this receipt.
  const digest = createHash("sha256").update(JSON.stringify({ definitions: originalDefinitions, files })).digest("hex");
  files[".claude/settings.json"] = JSON.stringify({ hooks });
  return { files, digest };
}
