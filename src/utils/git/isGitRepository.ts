/**
 * Async probe for "is this path inside a git working tree?". Callers inside
 * an Effect pass the fiber's abort signal so an interrupted probe kills the
 * `git` process instead of abandoning it.
 *
 * VS Code-free: falls back to the calling context's workspace root so
 * availability checks (e.g. the GitHub PR-subscription gate in
 * EXTERNAL_TOOL_DEFS) can live outside the command layer.
 */

import { workspaceRootPath } from '@utils/files/workspaceFS';
import { executeCommand } from '@utils/system/execUtils';

export async function isGitRepository(
  rootPath?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const cwd = rootPath ?? workspaceRootPath();
  if (!cwd) return false;
  const result = await executeCommand(
    ['git', 'rev-parse', '--is-inside-work-tree'],
    { cwd, timeout: 5_000, signal },
  );
  return result.success && result.stdout === 'true';
}
