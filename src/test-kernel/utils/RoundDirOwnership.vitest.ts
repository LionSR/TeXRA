import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, type FileSystem, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { RunIdSchema } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import { runDirUnder } from '@utils/files/runStorageFs';
import { RunFileService } from '@utils/files/runStorage';

const tempDirs = useTempDirs();

/** One of the file service's programs on the node `FileSystem` the process
 *  runtime serves it with in production. */
const runFileServiceProgram = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(nodePlatformLayer)));

/**
 * Creates a temp workspace + storage pair backed by the real node filesystem
 * and installs a platform pointing at it. Returns the workspace directory.
 */
async function installTempWorkspace(prefix: string): Promise<string> {
  const tempDir = await makeTempDir(prefix, tempDirs);

  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  await mkdir(workspaceDir, { recursive: true });
  await installFakePlatform(
    {
      workspacePath: workspaceDir,
      storagePath: resolveWorkspaceStoragePath(storageRoot, workspaceDir),
      globalStoragePath: resolveGlobalStoragePath(storageRoot),
    },
    {
      globalState: new MemoryStateStore(),
      workspaceState: new MemoryStateStore(),
    },
  );

  return workspaceDir;
}

describe('round-dir ownership', () => {
  // Failure mode: a mirror created over an entry already at its path
  // removed whatever stood there, the run's own file included.
  it('never replaces a real file at the mirror path with a link', async () => {
    const workspaceDir = await installTempWorkspace('texra-mirror-own-file-');
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await writeFile(stylePath, 'workspace\n');

    const runId = Schema.decodeUnknownSync(RunIdSchema)('c3c3c3c3c3c3');
    const runFile = path.join(
      runDirUnder(testWorkspaceRoots().storage, runId),
      'macros.sty',
    );
    await mkdir(path.dirname(runFile), { recursive: true });
    await writeFile(runFile, 'the run wrote this\n');

    const fileService = new RunFileService(runId, testWorkspaceRoots());
    await runFileServiceProgram(
      fileService.mirrorWorkspaceFile(
        createWorkspaceLocation(stylePath, 'macros.sty'),
      ),
    );

    expect((await lstat(runFile)).isSymbolicLink()).toBe(false);
    await expect(readFile(runFile, 'utf8')).resolves.toBe(
      'the run wrote this\n',
    );
  });
});
