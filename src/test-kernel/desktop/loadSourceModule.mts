// Node imports
import { resolve } from 'node:path';

// Local imports - desktop test paths
import {
  desktopSourcePath,
  moduleFileUrl,
  repoPath,
} from './desktopTestPaths.mjs';

/**
 * Source modules the desktop suite imports by absolute file URL rather than by
 * alias, so a test observes a module instance of its own (fresh across
 * `vi.resetModules()`, and built after any `vi.mock()` this file installs).
 *
 * Keys are the module's repo alias and each value pins its real module type,
 * so tests assert against the shipped surface instead of a hand-written mirror
 * that can drift.
 */
interface TestSourceModules {
  '@platform/defaults/jsonConfigProvider': typeof import('@platform/defaults/jsonConfigProvider');
  '@platform/defaults/jsonStore': typeof import('@platform/defaults/jsonStore');
  '@platform/defaults/nodeHost': typeof import('@platform/defaults/nodeHost');
  '@desktop/main/platform/dataRootMigration': typeof import('@desktop/main/platform/dataRootMigration');
  '@desktop/main/platform/electronSecrets': typeof import('@desktop/main/platform/electronSecrets');
  '@desktop/main/platform/pathFix': typeof import('@desktop/main/platform/pathFix');
  '@desktop/main/platform/paths': typeof import('@desktop/main/platform/paths');
  '@desktop/main/platform/secretStorageWarningDialog': typeof import('@desktop/main/platform/secretStorageWarningDialog');
}

const ALIAS_ROOTS: Record<string, string | undefined> = {
  '@platform': repoPath('src', 'platform'),
  '@desktop': desktopSourcePath(),
};

export async function loadSourceModule<K extends keyof TestSourceModules>(
  specifier: K,
): Promise<TestSourceModules[K]> {
  const [alias, ...segments] = specifier.split('/');
  const root = ALIAS_ROOTS[alias];
  if (root === undefined) {
    throw new Error(`No source root registered for alias "${alias}".`);
  }
  return import(moduleFileUrl(`${resolve(root, ...segments)}.ts`)) as Promise<
    TestSourceModules[K]
  >;
}
