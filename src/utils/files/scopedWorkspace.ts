// Local imports - filesystem
import { AbsoluteFS } from './absoluteFS';
import { WorkspaceRoot, type ResolvedPath } from './workspaceRoot';

/**
 * Workspace file operations scoped to a specific root directory.
 *
 * Uses composition: {@link WorkspaceRoot} resolves paths, {@link AbsoluteFS}
 * does I/O. No inheritance from the static FS hierarchy.
 *
 * @example
 * ```ts
 * const ws = new ScopedWorkspace('/path/to/worktree');
 * const content = await ws.read('src/main.tex');
 * const resolved = ws.locatePath('figures/plot.pdf');
 * ```
 */
export class ScopedWorkspace {
  public readonly wsRoot: WorkspaceRoot;

  constructor(rootPath: string) {
    this.wsRoot = new WorkspaceRoot(rootPath);
  }

  get root(): string {
    return this.wsRoot.root;
  }

  // -- Path resolution (delegates to WorkspaceRoot) --

  relativePath(filePath: string): string {
    return this.wsRoot.relativePath(filePath);
  }

  toAbsolute(filePath: string): string {
    return this.wsRoot.toAbsolute(filePath);
  }

  locatePath(inputPath: string): ResolvedPath {
    return this.wsRoot.locatePath(inputPath);
  }

  // -- File I/O (resolves path, then delegates to AbsoluteFS) --

  exists(target: string): Promise<boolean> {
    return AbsoluteFS.exists(this.wsRoot.toAbsolute(target));
  }

  read(target: string): Promise<string> {
    return AbsoluteFS.read(this.wsRoot.toAbsolute(target));
  }

  readBytes(target: string): Promise<Buffer> {
    return AbsoluteFS.readBytes(this.wsRoot.toAbsolute(target));
  }

  write(target: string, content: string | Uint8Array): Promise<void> {
    return AbsoluteFS.write(this.wsRoot.toAbsolute(target), content);
  }

  delete(
    target: string,
    options?: { recursive?: boolean; useTrash?: boolean },
  ): Promise<void> {
    return AbsoluteFS.delete(this.wsRoot.toAbsolute(target), options);
  }

  ensureDir(target: string): Promise<void> {
    return AbsoluteFS.ensureDir(this.wsRoot.toAbsolute(target));
  }

  stat(target: string) {
    return AbsoluteFS.stat(this.wsRoot.toAbsolute(target));
  }

  isDir(target: string): Promise<boolean> {
    return AbsoluteFS.isDir(this.wsRoot.toAbsolute(target));
  }

  isFile(target: string): Promise<boolean> {
    return AbsoluteFS.isFile(this.wsRoot.toAbsolute(target));
  }
}
