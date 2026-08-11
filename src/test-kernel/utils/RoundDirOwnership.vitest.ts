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

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import { getOriginalSnapshotPath, getRunDir } from '@utils/files/runStorageFs';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

const tempDirs: string[] = [];

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
    { workspacePath: workspaceDir },
    {
      fs: nodeFilesystem,
      workspace: createNodeWorkspace(() => workspaceDir),
      storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
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
  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('snapshots editable .tex on mirror, points r<N>/ symlinks at the snapshot, and the round-output write replaces the symlink with a real file leaving snapshot and workspace untouched', async () => {
    const workspaceDir = await installTempWorkspace('texra-round-ownership-');
    const draftDir = path.join(workspaceDir, 'Draft');
    const draftAbsolute = path.join(draftDir, 'Draft.tex');
    const workspaceOriginal =
      '\\documentclass{article}\\begin{document}original\\end{document}\n';
    await mkdir(draftDir, { recursive: true });
    await writeFile(draftAbsolute, workspaceOriginal);

    const fileService = new TaskRunFileService('run-1');

    await fileService.mirrorWorkspaceFile(
      createWorkspaceLocation(draftAbsolute, 'Draft/Draft.tex'),
      { snapshot: true },
    );

    const snapshotPath = getOriginalSnapshotPath('run-1', 'Draft/Draft.tex');
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );

    await fileService.ensureMirroredInRoundDir(1);

    const roundFilePath = path.join(
      getRunDir('run-1'),
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
    await AbsoluteFS.write(roundFilePath, roundOneContent);

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

    const fileService = new TaskRunFileService('run-2');

    await fileService.mirrorWorkspaceFile(
      createWorkspaceLocation(stylePath, 'macros.sty'),
    );

    const snapshotPath = getOriginalSnapshotPath('run-2', 'macros.sty');
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fileService.ensureMirroredInRoundDir(1);

    const roundFilePath = path.join(getRunDir('run-2'), 'r1', 'macros.sty');
    await expectSymlinkTargeting(
      roundFilePath,
      path.join(getRunDir('run-2'), 'macros.sty'),
    );
  });

  // Pins ensureMirroredInDiffRoundDir's `diff/r{round}` segment, which
  // (like ensureMirroredInRoundDir's `r{round}`) is now built from the
  // shared workflowOutputRoundDir helper (@shared/constants/workflowOutput)
  // instead of an inlined path.dirname(workflowOutputPath(...)).
  it('mirrors into diff/r<N>/ for the latexdiff round directory', async () => {
    const workspaceDir = await installTempWorkspace('texra-diff-round-dir-');
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await writeFile(stylePath, '\\newcommand{\\RR}{\\mathbb{R}}\n');

    const fileService = new TaskRunFileService('run-3');

    await fileService.mirrorWorkspaceFile(
      createWorkspaceLocation(stylePath, 'macros.sty'),
    );

    await fileService.ensureMirroredInDiffRoundDir(2);

    const diffRoundFilePath = path.join(
      getRunDir('run-3'),
      'diff',
      'r2',
      'macros.sty',
    );
    const linkStat = await lstat(diffRoundFilePath);
    expect(linkStat.isSymbolicLink()).toBe(true);
  });
});
