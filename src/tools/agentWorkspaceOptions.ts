// Standard library imports
import * as path from 'node:path';

import { escapesRoot } from '@utils/core/pathCore';

export interface AgentWorkspaceOptions {
  workingDirectory?: string;
  additionalDirectories?: string[];
}

/**
 * Resolve the working directory and any extra workspace roots for external
 * agent SDKs that need access to the project at `workspacePath` (the calling
 * session's `roots.workspace`, passed as data). `workingDirectory` is the
 * run's, already absolute or absent (decided where the run launched).
 *
 * When no directory is provided, the agent runs from the workspace root.
 * When a subdirectory inside the workspace is provided, we still add the
 * workspace root so the agent can inspect sibling files across the project.
 * Absolute paths outside the workspace (for example a separate git worktree)
 * run in that directory without inheriting the current workspace as an
 * additional root.
 */
export function buildAgentWorkspaceOptions(
  workspacePath: string | undefined,
  workingDirectory?: string,
): AgentWorkspaceOptions {
  if (!workspacePath) {
    return workingDirectory ? { workingDirectory } : {};
  }
  if (!workingDirectory) return { workingDirectory: workspacePath };

  const relativeToWorkspace = path.relative(
    path.resolve(workspacePath),
    path.resolve(workingDirectory),
  );
  const isInsideWorkspace =
    relativeToWorkspace.length > 0 &&
    !escapesRoot(relativeToWorkspace) &&
    !path.isAbsolute(relativeToWorkspace);

  return isInsideWorkspace
    ? { workingDirectory, additionalDirectories: [workspacePath] }
    : { workingDirectory };
}
