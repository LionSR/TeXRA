// Node imports
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Effect } from 'effect';
import { afterEach } from 'vitest';

// Local imports
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';

// Local file imports
import { createFakeHost, type FakeHost } from './setupPlatform';

/**
 * Creates a fresh temp directory and records it on `tempDirs` for later
 * cleanup via `cleanupTempDirs`.
 *
 * Resolves the realpath so the returned path is canonical: on Windows CI the
 * 8.3 short-name form of the temp dir (`RUNNER~1`) differs from the resolved
 * long form (`runneradmin`), while on macOS the temporary root may traverse
 * the `/tmp` to `/private/tmp` symlink. Production code that resolves either
 * path would otherwise produce a path that never equals the one returned here.
 */
export async function makeTempDir(
  prefix: string,
  tempDirs: string[],
): Promise<string> {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(tempDir);
  return tempDir;
}

/**
 * Creates a fake host rooted in a fresh temp directory of its own
 * (`<tempDir>/workspace` and `<tempDir>/storage`), and records the temp
 * directory on `tempDirs` for later cleanup via `cleanupTempDirs`.
 */
export async function createTempDirPlatform(
  prefix: string,
  tempDirs: string[],
): Promise<FakeHost> {
  const tempDir = await makeTempDir(prefix, tempDirs);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return createFakeHost({
    workspacePath: workspaceDir,
    storagePath: resolveWorkspaceStoragePath(storageRoot, workspaceDir),
    globalStoragePath: resolveGlobalStoragePath(storageRoot),
  });
}

/**
 * Returns a `tempDirs` registry for `makeTempDir` / `createTempDirPlatform`
 * and registers the `afterEach` that empties it — the declaration form of the
 * registry-plus-cleanup-hook pair every suite used to hand-write. Call it once
 * at module scope, or inside a `describe` when the registry is suite-local.
 */
export function useTempDirs(): string[] {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });
  return tempDirs;
}

/**
 * Removes every directory recorded by `createTempDirPlatform` (or pushed
 * manually), then clears the list. A session over one of them is closed
 * first by the scope that opened it: a test's own scope (`TestSession.open`,
 * `isolatedTestSession`) closes before its hooks run.
 */
export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  const uniqueDirs = [...new Set(tempDirs.splice(0))];
  await Promise.all(
    uniqueDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** A real temporary directory owned for the duration of an Effect test operation. */
export function withTempDirEffect<A, E, R>(
  prefix: string,
  run: (directory: string) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(() =>
      mkdtemp(path.join(os.tmpdir(), prefix)).then((directory) =>
        realpath(directory),
      ),
    ),
    run,
    (directory) =>
      Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
}
