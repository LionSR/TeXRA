/**
 * Platform workspace provider interface.
 */
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
