import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES, toSshTarExcludes } from "./ssh-workspace-excludes.js";

const execFileAsync = promisify(execFile);

// Run the same discovery on the archive's creating host. Do not follow links,
// enter Git metadata, or descend into a linked checkout after identifying it.
// A gitfile alone is not enough: submodules and separate-git-dir repositories
// have them too. A linked worktree's gitdir has a commondir file.
// NUL-delimited output keeps spaces, newlines and shell metacharacters literal.
export const SSH_NESTED_WORKTREES_SCRIPT = [
  "set -e",
  "walk() {",
  '  for candidate in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
  '    [ -d "$candidate" ] && [ ! -L "$candidate" ] || continue',
  '    case "$candidate" in',
  `      ${SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((entry) => `"./${entry}"`).join("|")}|*/.git) continue ;;`,
  "    esac",
  '    if [ -f "$candidate/.git" ] && [ ! -L "$candidate/.git" ]; then',
  '      gitdir_line=""',
  '      [ -r "$candidate/.git" ] || exit 1',
  '      IFS= read -r gitdir_line < "$candidate/.git" || :',
  '      case "$gitdir_line" in',
  '        "gitdir: "*)',
  '          gitdir=${gitdir_line#"gitdir: "}',
  '          case "$gitdir" in /*) ;; *) gitdir="$candidate/$gitdir" ;; esac',
  '          if [ -f "$gitdir/commondir" ]; then',
  '            printf "%s\\0" "$candidate"',
  "            continue",
  "          fi",
  "          ;;",
  "      esac",
  "    fi",
  '    walk "$candidate"',
  "  done",
  "}",
  "walk .",
].join("\n");

export function parseSshNestedWorktrees(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean).map((entry) => {
    if (!entry.startsWith("./") || entry.split("/").includes("..")) {
      throw new Error("Invalid nested SSH worktree path");
    }
    return entry.slice(2);
  });
}

export async function discoverSshNestedWorktrees(localDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("sh", ["-c", SSH_NESTED_WORKTREES_SCRIPT], {
    cwd: localDir,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return parseSshNestedWorktrees(stdout);
}

/** Exact root-relative paths, not globs, in either creating tar's dialect. */
export function nestedWorktreeTarExcludes(paths: readonly string[]): string[] {
  return toSshTarExcludes(paths, paths);
}
