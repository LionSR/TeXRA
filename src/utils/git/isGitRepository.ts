/**
 * Async probe for "is this path inside a git working tree?". Callers inside
 * an Effect pass the fiber's abort signal so an interrupted probe kills the
 * `git` process instead of abandoning it.
 *
 * VS Code-free: uses the injected WorkspaceFS provider for the default root
 * so availability checks (e.g. the GitHub PR-subscription gate in
 * EXTERNAL_TOOL_DEFS) can live outside the command layer.
 */

import { WorkspaceFS } from '@utils/files/workspaceFS';
import { executeCommand } from '@utils/system/execUtils';

export async function isGitRepository(
  rootPath?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const cwd = rootPath ?? WorkspaceFS.getPath();
  if (!cwd) return false;
  const result = await executeCommand(
    ['git', 'rev-parse', '--is-inside-work-tree'],
    { cwd, timeout: 5_000, signal },
  );
  return result.success && result.stdout === 'true';
}
