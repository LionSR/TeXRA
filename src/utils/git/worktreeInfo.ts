/**
 * The worktree context a run's `run.start` carries.
 *
 * Host-neutral and side-effect free: the fold never shells out, so the worktree
 * is the run's working directory as a bare path chip, and `branch`/`dirty` stay
 * absent. Resolving them (a per-path cache plus `probeWorktree`) had no entry
 * point left after `resolveWorktreeInfo` was deleted, so it went with it — a
 * host that wants them again owns a cache writer, not just a reader.
 */

import type { WorktreeInfo } from '@shared/schemas';

/**
 * The worktree a run's `run.start` carries (PRD one-fold-three-renderers,
 * section 6, item 4).
 */
export function launchWorktreeInfo(
  workingDirectory: string | null | undefined,
): WorktreeInfo | undefined {
  const cwd = workingDirectory?.trim();
  if (!cwd) return undefined;
  return { workingDirectory: cwd };
}
