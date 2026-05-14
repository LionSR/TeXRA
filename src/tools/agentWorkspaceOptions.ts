// Standard library imports
import * as path from 'path';

// Local imports - files
import { WorkspaceFS } from '@utils/files';

export interface AgentWorkspaceOptions {
  workingDirectory?: string;
  additionalDirectories?: string[];
}

/**
 * Resolve the working directory and any extra workspace roots for external
 * agent SDKs that need access to the current project.
 */
export function buildAgentWorkspaceOptions(
  workingDirectoryInput?: string | null,
): AgentWorkspaceOptions {
  const workspacePath = WorkspaceFS.getPath();
  const trimmed = workingDirectoryInput?.trim();

  if (!workspacePath) {
    return trimmed ? { workingDirectory: trimmed } : {};
  }

  const workingDirectory = trimmed
    ? path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(workspacePath, trimmed)
    : workspacePath;

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
