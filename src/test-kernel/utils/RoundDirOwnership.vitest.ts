import {
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, type FileSystem } from 'effect';
import { describe, expect, it } from 'vitest';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { RunIdSchema } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import {
  originalSnapshotPathUnder,
  runDirUnder,
} from '@utils/files/runStorageFs';
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

  const storage = new WorkspaceStorageProvider(storageRoot, workspaceDir);
  await installFakePlatform(
    {
      workspacePath: workspaceDir,
      storagePath: storage.getStoragePath(),
      globalStoragePath: storage.getGlobalStoragePath(),
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
  it('snapshots editable .tex on mirror, points r<N>/ symlinks at the snapshot, and the round-output write replaces the symlink with a real file leaving snapshot and workspace untouched', async () => {
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

    const snapshotPath = originalSnapshotPathUnder(
      testWorkspaceRoots().storage,
      runId,
      'Draft/Draft.tex',
    );
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );

    await runFileServiceProgram(fileService.ensureMirroredInRoundDir(1));

    const roundFilePath = path.join(
      runDirUnder(testWorkspaceRoots().storage, runId),
      'r1',
      'Draft',
      'Draft.tex',
    );

    await expectSymlinkTargeting(roundFilePath, snapshotPath);

    // Inline the writeRoundOutput contract so the test is host-neutral
    // (no platform wiring needed) and the ownership handoff is visible.
    const roundOneContent =
      '\\documentclass{article}\\begin{document}round 1\\end{document}\n';
    const pre = await lstat(roundFilePath);
    if (pre.isSymbolicLink()) await unlink(roundFilePath);
    await writeFile(roundFilePath, roundOneContent);

    const post = await lstat(roundFilePath);
    expect(post.isSymbolicLink()).toBe(false);
    expect(post.isFile()).toBe(true);
    await expect(readFile(roundFilePath, 'utf8')).resolves.toBe(
      roundOneContent,
    );

    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );
    await expect(readFile(draftAbsolute, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );
    const workspaceStat = await stat(draftAbsolute);
    expect(workspaceStat.size).toBe(workspaceOriginal.length);
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

    const snapshotPath = originalSnapshotPathUnder(
      testWorkspaceRoots().storage,
      runId,
      'macros.sty',
    );
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await runFileServiceProgram(fileService.ensureMirroredInRoundDir(1));

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

  // Pins ensureMirroredInDiffRoundDir's `diff/r{round}` segment, which
  // (like ensureMirroredInRoundDir's `r{round}`) is now built from the
  // shared workflowOutputRoundDir helper (@shared/constants/workflowOutput)
  // instead of an inlined path.dirname(workflowOutputPath(...)).
});
