/**
 * Platform-agnostic workspace provider facade for the agent core.
 *
 * Thin wrapper over `platform().workspace`. Consumer code imports this
 * module for convenience; the canonical definition lives in
 * `@platform/interfaces`.
 */
import { platform } from '@platform/platform';

export interface WorkspaceProvider {
  /** The workspace root path, or undefined if none is open. */
  getWorkspacePath(): string | undefined;

  /**
   * Convert an absolute path to a workspace-relative path.
   * Should be symlink-aware where possible.
   * Returns the original path if it is outside the workspace.
   */
  asRelativePath(filePath: string): string;
}

/** Get the active workspace provider. */
export function getWorkspaceProvider(): WorkspaceProvider {
  return platform().workspace;
}
