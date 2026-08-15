// Node imports
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Platform defaults

// Local imports
import type { Platform } from '@platform/platform';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';

// Local file imports
import { createFakePlatform } from './FakePlatform';

/**
 * Creates a fresh temp directory and records it on `tempDirs` for later
 * cleanup via `cleanupTempDirs`.
 *
 * Resolves the realpath so the returned path is canonical: on Windows CI the
 * 8.3 short-name form of the temp dir (`RUNNER~1`) differs from the resolved
 * long form (`runneradmin`), and production code that realpaths the temp dir
 * would otherwise produce a path that never equals the one returned here.
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
 * Creates a node-backed `FakePlatform` rooted in a fresh temp directory
 * (`<tempDir>/workspace` and `<tempDir>/storage`), and records the temp
 * directory on `tempDirs` for later cleanup via `cleanupTempDirs`.
 */
export async function createTempDirPlatform(
  prefix: string,
  tempDirs: string[],
): Promise<Platform> {
  const tempDir = await makeTempDir(prefix, tempDirs);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return createFakePlatform(
    { workspacePath: workspaceDir },
    {
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspaceDir),
      storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
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

/** Removes every directory recorded by `createTempDirPlatform` (or pushed manually), then clears the list. */
export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  const uniqueDirs = [...new Set(tempDirs.splice(0))];
  await Promise.all(
    uniqueDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
