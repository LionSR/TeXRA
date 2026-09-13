// Node imports
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Effect } from 'effect';
import { afterEach } from 'vitest';

// Platform defaults

// Local imports
import { closeSession, listSessions } from '@agent/runtime/sessionGraph';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

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
 * Creates a node-backed fake host rooted in a fresh temp directory
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
  const storage = new WorkspaceStorageProvider(storageRoot, workspaceDir);
  return createFakeHost(
    {
      workspacePath: workspaceDir,
      storagePath: storage.getStoragePath(),
      globalStoragePath: storage.getGlobalStoragePath(),
    },
    {
      fs: nodeFilesystem,
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );
}

/**
 * Runs `run` against a fresh temp directory and always removes the directory
 * when the scope exits — the scoped form of the `tempDirs` registry for
 * suites that create and tear down a directory within a single test (or a
 * file-local `withX` fixture). Like {@link makeTempDir}, the path handed to
 * `run` is realpath-canonicalized.
 */
export async function withTempDir<T>(
  prefix: string,
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDirs: string[] = [];
  try {
    return await run(await makeTempDir(prefix, tempDirs));
  } finally {
    await cleanupTempDirs(tempDirs);
  }
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

/** Removes every directory recorded by `createTempDirPlatform` (or pushed manually), then clears the list. */
export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  const uniqueDirs = [...new Set(tempDirs.splice(0))];
  const sessionRoots = new Set(
    (await Effect.runPromise(listSessions()))
      .filter((session) =>
        uniqueDirs.some((directory) => {
          const relative = path.relative(directory, session.roots.storage);
          return (
            relative === '' ||
            (relative !== '..' &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        }),
      )
      .map((session) => session.roots.storage),
  );
  const reports = await Effect.runPromise(
    Effect.forEach(sessionRoots, (root) => closeSession(root), {
      concurrency: 'unbounded',
    }),
  );
  const abandoned = reports.flatMap((report) => report.abandoned);
  if (reports.some((report) => !report.settled) || abandoned.length > 0) {
    throw new Error(
      `Cannot remove temporary directories while sessions still own runs: ${abandoned.join(', ')}`,
    );
  }
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
