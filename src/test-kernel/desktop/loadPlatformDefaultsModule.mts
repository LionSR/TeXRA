// Local imports - desktop test paths
import { moduleFileUrl, repoPath } from './desktopTestPaths.mjs';

/**
 * Load a module from `src/platform/defaults/` via dynamic import.
 *
 * Mirrors `loadDesktopPlatformModule` but resolves against the shared
 * platform-defaults directory rather than the desktop-only `main/platform`
 * tree. Use this for modules (e.g. `JsonStore`, `configKeyHelpers`) that
 * moved out of the desktop package after consolidation.
 */
export async function loadPlatformDefaultsModule<T>(
  moduleName: string,
): Promise<T> {
  return import(
    moduleFileUrl(repoPath('src', 'platform', 'defaults', moduleName))
  ) as Promise<T>;
}
