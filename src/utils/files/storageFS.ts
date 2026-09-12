// Platform imports
import { workspaceRoots } from '@platform/workspaceRoots';

// Local imports - fs
import { RelativeFS } from './relativeFS';

/**
 * A `RelativeFS` rooted at one of the calling session's storage roots
 * (`WorkspaceRoots`). Both roots come from the same read, resolved per call so
 * a run writes under its own paper's root. Default: ~/.texra/ paths.
 */
abstract class SessionStorageFS extends RelativeFS {
  /** Which of the session's roots this facade resolves paths against. */
  protected static readonly root: 'storage' | 'globalStorage';

  protected static override getBasePath(): string {
    return workspaceRoots()[this.root];
  }
}

/**
 * StorageFS provides a unified interface for extension storage operations:
 * the per-workspace storage root of the session doing the work.
 */
export class StorageFS extends SessionStorageFS {
  protected static override readonly root = 'storage';
}

/**
 * GlobalStorageFS provides operations for global storage — the cross-workspace
 * root, shared by every session of the process.
 */
export class GlobalStorageFS extends SessionStorageFS {
  protected static override readonly root = 'globalStorage';
}
