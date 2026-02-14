// Standard library imports
import * as path from 'path';

// Local imports - filesystem
import { RelativeFS } from './relativeFS';
import { WorkspaceRoot, type ResolvedPath } from './workspaceRoot';

/**
 * A workspace FS scoped to a specific root directory.
 *
 * Unlike the static {@link WorkspaceFS} (which always reads from
 * `vscode.workspace.workspaceFolders[0]`), a scoped FS is bound to an
 * explicit root path at construction time. This enables:
 *
 * - **Git worktrees**: Each worktree gets its own scoped FS pointing
 *   to its checkout directory.
 * - **Parallel operations**: Multiple scoped FS instances can coexist,
 *   each targeting a different directory.
 * - **Testing**: No VS Code workspace mocking required.
 *
 * Inherits all file I/O operations from {@link RelativeFS}.
 * Path resolution uses the pure {@link WorkspaceRoot} implementation.
 */
export class ScopedWorkspaceFS extends RelativeFS {
  private static _root: string;

  /** Set the root for the next instance created via `createScopedWorkspaceFS`. */
  static _setRoot(root: string): void {
    this._root = root;
  }

  protected static override getBasePath(): string {
    return this._root;
  }
}

/**
 * Instance-based workspace file operations scoped to a specific root.
 *
 * Wraps the static {@link ScopedWorkspaceFS} pattern with a proper object
 * that carries its own {@link WorkspaceRoot} for path resolution.
 */
export class ScopedWorkspace {
  public readonly wsRoot: WorkspaceRoot;
  private readonly FSClass: typeof ScopedWorkspaceFS;

  constructor(rootPath: string) {
    this.wsRoot = new WorkspaceRoot(rootPath);

    // Create a unique subclass so each ScopedWorkspace gets its own static _root.
    // Without this, multiple ScopedWorkspace instances would share state.
    this.FSClass = class extends ScopedWorkspaceFS {};
    this.FSClass._setRoot(rootPath);
  }

  get root(): string {
    return this.wsRoot.root;
  }

  /** Delegate file I/O to the scoped static FS class. */
  get fs(): typeof ScopedWorkspaceFS {
    return this.FSClass;
  }

  relativePath(filePath: string): string {
    return this.wsRoot.relativePath(filePath);
  }

  toAbsolute(filePath: string): string {
    return this.wsRoot.toAbsolute(filePath);
  }

  locatePath(inputPath: string): ResolvedPath {
    return this.wsRoot.locatePath(inputPath);
  }
}

/**
 * Create a scoped workspace bound to a specific root directory.
 *
 * Returns a {@link ScopedWorkspace} that provides:
 * - `wsRoot` — the {@link WorkspaceRoot} value object for path resolution
 * - `fs` — a static FS class (extends {@link RelativeFS}) for file I/O
 * - Convenience methods: `relativePath`, `toAbsolute`, `locatePath`
 *
 * @example
 * ```ts
 * // For a git worktree
 * const worktree = createScopedWorkspace('/path/to/worktree');
 * const content = await worktree.fs.read('src/main.tex');
 * const resolved = worktree.locatePath('figures/plot.pdf');
 * ```
 */
export function createScopedWorkspace(rootPath: string): ScopedWorkspace {
  return new ScopedWorkspace(rootPath);
}
