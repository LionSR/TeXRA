// Standard library imports
import * as path from 'node:path';

// Local imports - files
import { WorkspaceFS } from '@utils/files/workspaceFS';

export interface AgentWorkspaceOptions {
  workingDirectory?: string;
  additionalDirectories?: string[];
}

/**
 * Resolve the working directory and any extra workspace roots for external
 * agent SDKs that need access to the current project.
 *
 * When no directory is provided, the agent runs from the workspace root.
 * When a subdirectory inside the workspace is provided, we still add the
 * workspace root so the agent can inspect sibling files across the project.
 * Absolute paths outside the workspace (for example a separate git worktree)
 * run in that directory without inheriting the current workspace as an
 * additional root.
 */
export function buildAgentWorkspaceOptions(
  workingDirectoryInput?: string | null,
): AgentWorkspaceOptions {
  const workspacePath = WorkspaceFS.getPath();
  const trimmed = workingDirectoryInput?.trim();

  if (!workspacePath) {
    return trimmed ? { workingDirectory: trimmed } : {};
  }

  let workingDirectory: string;
  if (!trimmed) {
    workingDirectory = workspacePath;
  } else if (path.isAbsolute(trimmed)) {
    workingDirectory = trimmed;
  } else {
    workingDirectory = path.resolve(workspacePath, trimmed);
  }

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);

  if (resolvedWorkingDirectory === resolvedWorkspacePath) {
    return { workingDirectory };
  }

  const relativeToWorkspace = path.relative(
    resolvedWorkspacePath,
    resolvedWorkingDirectory,
  );
  const isInsideWorkspace =
    relativeToWorkspace.length > 0 &&
    !relativeToWorkspace.startsWith('..') &&
    !path.isAbsolute(relativeToWorkspace);

  return isInsideWorkspace
    ? {
        workingDirectory,
        additionalDirectories: [workspacePath],
      }
    : { workingDirectory };
}
