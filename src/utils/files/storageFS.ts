// Platform imports
import { workspaceRoots } from '@platform/workspaceRoots';

// Local imports - fs
import { RelativeFS } from './relativeFS';

/**
 * StorageFS provides a unified interface for extension storage operations:
 * the per-workspace storage root of the session doing the work, resolved per
 * call so a run writes under its own project's root. Default: ~/.texra/ paths.
 *
 * The cross-workspace root has no facade: its consumers take the rooted
 * `GlobalStorageFs` service from context (#12421).
 */
export class StorageFS extends RelativeFS {
  protected static override getBasePath(): string {
    return workspaceRoots().storage;
  }
}
