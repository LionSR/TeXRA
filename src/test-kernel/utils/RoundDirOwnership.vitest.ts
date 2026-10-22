import {
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, type FileSystem } from 'effect';
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
import {
  WORKFLOW_OUTPUT_BASENAME,
  workflowOutputRoundDir,
} from '@texra/shared/constants/workflowOutput';
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

async function expectSymlinkTargeting(
  filePath: string,
  expectedTarget: string,
): Promise<void> {
  const linkStat = await lstat(filePath);
  expect(linkStat.isSymbolicLink()).toBe(true);
  const linkTarget = await readlink(filePath);
  expect(path.resolve(path.dirname(filePath), linkTarget)).toBe(expectedTarget);
}

describe('round-dir ownership and editable .tex inheritance', () => {
  it('snapshots editable .tex on mirror and points r<N>/ symlinks at the snapshot', async () => {
    const workspaceDir = await installTempWorkspace('texra-round-ownership-');
    const draftDir = path.join(workspaceDir, 'Draft');
    const draftAbsolute = path.join(draftDir, 'Draft.tex');
    const workspaceOriginal =
      '\\documentclass{article}\\begin{document}original\\end{document}\n';
    await mkdir(draftDir, { recursive: true });
    await writeFile(draftAbsolute, workspaceOriginal);

    const runId = RunIdSchema.parse('a1a1a1a1a1a1');
    const fileService = new RunFileService(runId, testWorkspaceRoots());

    await runFileServiceProgram(
      fileService.mirrorWorkspaceFile(
        createWorkspaceLocation(draftAbsolute, 'Draft/Draft.tex'),
        { snapshot: true },
      ),
    );

    const snapshotPath = fileService.originalSnapshotPath('Draft/Draft.tex');
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );

    await runFileServiceProgram(
      fileService.ensureMirroredInRunSubdir(workflowOutputRoundDir(1), {
        protectedStem: WORKFLOW_OUTPUT_BASENAME,
      }),
    );

    const roundFilePath = path.join(
      runDirUnder(testWorkspaceRoots().storage, runId),
      'r1',
      'Draft',
      'Draft.tex',
    );

    await expectSymlinkTargeting(roundFilePath, snapshotPath);
  });

  it('falls through to the workspace symlink for non-snapshotted (read-only) deps', async () => {
    const workspaceDir = await installTempWorkspace('texra-readonly-mirror-');
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await writeFile(stylePath, '\\newcommand{\\RR}{\\mathbb{R}}\n');

    const runId = RunIdSchema.parse('b2b2b2b2b2b2');
    const fileService = new RunFileService(runId, testWorkspaceRoots());

    await runFileServiceProgram(
      fileService.mirrorWorkspaceFile(
        createWorkspaceLocation(stylePath, 'macros.sty'),
      ),
    );

    const snapshotPath = fileService.originalSnapshotPath('macros.sty');
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await runFileServiceProgram(
      fileService.ensureMirroredInRunSubdir(workflowOutputRoundDir(1), {
        protectedStem: WORKFLOW_OUTPUT_BASENAME,
      }),
    );

    const roundFilePath = path.join(
      runDirUnder(testWorkspaceRoots().storage, runId),
      'r1',
      'macros.sty',
    );
    await expectSymlinkTargeting(
      roundFilePath,
      path.join(runDirUnder(testWorkspaceRoots().storage, runId), 'macros.sty'),
    );
  });

  // Failure mode: a mirror created over an entry already at its path
  // removed whatever stood there, the run's own file included.
  it('never replaces a real file at the mirror path with a link', async () => {
    const workspaceDir = await installTempWorkspace('texra-mirror-own-file-');
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await writeFile(stylePath, 'workspace\n');

    const runId = RunIdSchema.parse('c3c3c3c3c3c3');
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
