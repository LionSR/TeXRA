// Standard library imports
import * as path from 'path';

/**
 * Result of resolving a path against a workspace root.
 * 'workspace' paths have both absolute and forward-slash relative forms.
 * 'external' paths are outside the workspace (or no workspace is open).
 */
export type ResolvedPath =
  | { kind: 'workspace'; absolutePath: string; relativePath: string }
  | { kind: 'external'; absolutePath: string };

/**
 * Value object representing a workspace root directory.
 *
 * Encapsulates all path resolution logic (relative ↔ absolute, locate)
 * without coupling to VS Code APIs or file I/O. This separation enables:
 *
 * - **Git worktrees**: Each worktree gets its own `WorkspaceRoot` instance
 *   pointing to its checkout directory.
 * - **Parallel workspaces**: Multiple agent executions can operate against
 *   different roots simultaneously.
 * - **Testing**: Path logic is testable without mocking `vscode.workspace`.
 *
 * The class is intentionally immutable — the root path is fixed at construction.
 */
export class WorkspaceRoot {
  constructor(public readonly root: string) {}

  /**
   * Convert an absolute path to a workspace-relative path.
   *
   * Always returns forward slashes for cross-platform consistency.
   * Returns the original path if it falls outside this workspace.
   */
  relativePath(filePath: string): string {
    const normalized = path.resolve(filePath);
    const normalizedRoot = path.resolve(this.root);

    // Check if path is under this workspace root
    if (
      !normalized.startsWith(normalizedRoot + path.sep) &&
      normalized !== normalizedRoot
    ) {
      return filePath;
    }

    return path.relative(normalizedRoot, normalized).replaceAll('\\', '/');
  }

  /**
   * Convert a file path to an absolute path.
   * If already absolute, returns unchanged. Otherwise resolves relative to workspace root.
   */
  toAbsolute(filePath: string): string {
    return path.isAbsolute(filePath)
      ? filePath
      : path.join(this.root, filePath);
  }

  /**
   * Resolve a path (absolute or relative) against the workspace root.
   *
   * This is the single resolution primitive for workspace path handling.
   * Returns a discriminated union — callers apply their own policy
   * (throw on external, create ExternalFileLocation, etc.).
   *
   * Relative paths are normalized to forward slashes. Paths that escape
   * via `..` are treated as external.
   */
  locatePath(inputPath: string): ResolvedPath {
    if (!inputPath) {
      return {
        kind: 'workspace',
        absolutePath: this.root,
        relativePath: '',
      };
    }

    if (path.isAbsolute(inputPath)) {
      const relative = this.relativePath(inputPath);
      if (!path.isAbsolute(relative) && !relative.startsWith('..')) {
        return {
          kind: 'workspace',
          absolutePath: inputPath,
          relativePath: relative,
        };
      }
      return { kind: 'external', absolutePath: inputPath };
    }

    // Relative path — convert backslashes to forward slashes BEFORE normalizing
    // so that path.posix.normalize() can properly collapse '..' segments.
    // On POSIX, backslashes are valid filename characters, so path.normalize()
    // would preserve them; the subsequent replaceAll would then create new
    // path separators that could form '..' traversals bypassing the check below.
    const relative = path.posix.normalize(inputPath.replaceAll('\\', '/'));
    if (relative.startsWith('..')) {
      return {
        kind: 'external',
        absolutePath: path.resolve(this.root, inputPath),
      };
    }
    return {
      kind: 'workspace',
      absolutePath: path.join(this.root, relative),
      relativePath: relative,
    };
  }
}
