// Agent-local scratch directories that are never workspace deliverables. They
// are excluded from SSH workspace export and sync-back in both directions:
// nested agent worktrees are full checkouts that can each hold their own build
// outputs, and syncing them once cost a production host its root disk (a
// sync-back staging copy grew until ENOSPC broke every agent on the host).
// Rebuildable outputs stay out for the same reason; the remote run reinstalls
// or rebuilds them instead of receiving them over the wire.
//
// These are workspace-root-relative paths and match ONLY at the workspace
// root, never at depth: a nested `src/commands/target/` is tracked source, not
// scratch. This list is the merge/snapshot grammar (`excludePatternMatches`
// already anchors a plain entry at the root); the tar grammar is the derived
// `SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES`. Both must stay in step.
export const SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES = [
  ".paperclip-runtime",
  ".claude/worktrees",
  "node_modules",
  "target",
] as const;

// `./` denotes a root-relative exclude in the transfer API. GNU tar accepts
// it directly, but bsdtar strips it and needs `^` instead. Resolve the dialect
// where the archive is created, not from the OS of the receiving host.
export const SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES: readonly string[] =
  SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((entry) => `./${entry}`);

export type SshTarFlavor = "gnu" | "bsd";

export function resolveSshTarFlavor(version: string): SshTarFlavor {
  if (version.includes("GNU tar")) return "gnu";
  if (version.trimStart().startsWith("bsdtar ")) return "bsd";
  throw new Error("Unsupported tar for root-relative SSH workspace excludes; use GNU tar or bsdtar");
}

/** Translate workspace snapshot excludes into root-relative transfer patterns. */
export function toSshTarExcludes(exclude: readonly string[]): string[] {
  const scratch = new Set<string>(SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES);
  return [...new Set(exclude.map((entry) => scratch.has(entry) ? `./${entry}` : entry))];
}

/**
 * Translate explicit root-relative transfer patterns for the creating tar.
 * Generic unanchored patterns keep their existing tar semantics.
 * libarchive's `^` anchor: https://github.com/libarchive/libarchive/blob/v3.7.4/libarchive/archive_pathmatch.c
 */
export function translateSshTarExcludes(exclude: readonly string[], flavor: SshTarFlavor): string[] {
  return exclude.map((entry) => flavor === "bsd" && entry.startsWith("./") ? `^${entry.slice(2)}` : entry);
}
