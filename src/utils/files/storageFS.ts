// Standard library imports
import * as path from 'node:path';

// Platform imports
import { workspaceRoots } from '@platform/workspaceRoots';

// Local imports - fs
import { BaseFS } from './baseFS';

/**
 * StorageFS provides a unified interface for extension storage operations:
 * the per-workspace storage root of the session doing the work, resolved per
 * call so a run writes under its own project's root. Default: ~/.texra/ paths.
 *
 * The cross-workspace root has no facade: its consumers take the rooted
 * `GlobalStorageFs` service from context (#12421).
 */
export class StorageFS extends BaseFS {
  protected static override resolvePath(target: string): string {
    // An absolute target is returned directly: path.join() would concatenate
    // it onto the storage root instead of returning it.
    return path.isAbsolute(target)
      ? target
      : path.join(workspaceRoots().storage, target);
  }
}
