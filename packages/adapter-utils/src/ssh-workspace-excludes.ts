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

// tar matches a bare `--exclude target` against every path component, so the
// same names must be anchored to the archive root (`./`, since the transfer
// archives `.`) to match only at the workspace root.
export const SSH_WORKSPACE_AGENT_LOCAL_TAR_EXCLUDES: readonly string[] =
  SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES.map((entry) => `./${entry}`);

/**
 * Translate a merge/snapshot-grammar exclude list into tar grammar. Entries
 * that name agent-local scratch are anchored to the workspace root; every other
 * entry passes through unchanged, so existing excludes keep their behavior. A
 * snapshot's exclude list must go through this before it reaches tar, or its
 * plain `target` would match `src/commands/target/` at depth.
 */
export function toSshTarExcludes(exclude: readonly string[]): string[] {
  const scratch = new Set<string>(SSH_WORKSPACE_AGENT_LOCAL_EXCLUDES);
  return [...new Set(exclude.map((entry) => (scratch.has(entry) ? `./${entry}` : entry)))];
}
