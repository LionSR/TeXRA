/**
 * Platform-agnostic workspace provider for the agent core.
 *
 * Delegates to a settable backend. Default: uses process.cwd().
 * VS Code calls `setWorkspaceProvider()` at activation to use
 * vscode.workspace.workspaceFolders and asRelativePath.
 */
import * as path from 'path';

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

// ---------------------------------------------------------------------------
// Default backend – uses process.cwd() (for CLI / Electron / tests)
// ---------------------------------------------------------------------------

const defaultBackend: WorkspaceProvider = {
  getWorkspacePath(): string | undefined {
    return process.cwd();
  },

  asRelativePath(filePath: string): string {
    const root = this.getWorkspacePath();
    if (!root) return filePath;
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return filePath;
    }
    return relative.replaceAll('\\', '/');
  },
};

// ---------------------------------------------------------------------------
// Settable backend
// ---------------------------------------------------------------------------

let backend: WorkspaceProvider = defaultBackend;

/** Replace the workspace provider. Called once at platform init. */
export function setWorkspaceProvider(provider: WorkspaceProvider): void {
  backend = provider;
}

/** Get the active workspace provider. */
export function getWorkspaceProvider(): WorkspaceProvider {
  return backend;
}
