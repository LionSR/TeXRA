// Standard library imports
import * as path from 'node:path';
import { isStrictlyWithin } from '@texra-ai/harness/host';

interface AgentWorkspaceOptions {
  workingDirectory?: string;
  additionalDirectories?: string[];
}

/**
 * Resolve the working directory and any extra workspace roots for external
 * agent SDKs that need access to the project at `workspaceRoot` (the calling
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
  workspaceRoot: string | undefined,
  workingDirectory?: string,
): AgentWorkspaceOptions {
  if (!workspaceRoot) {
    return workingDirectory ? { workingDirectory } : {};
  }
  if (!workingDirectory) return { workingDirectory: workspaceRoot };

  const isInsideWorkspace = isStrictlyWithin(
    path.resolve(workspaceRoot),
    path.resolve(workingDirectory),
  );

  return isInsideWorkspace
    ? { workingDirectory, additionalDirectories: [workspaceRoot] }
    : { workingDirectory };
}
