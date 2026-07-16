import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs } from '@test/support/tempDirPlatform';
import {
  AbsoluteFS,
  createWorkspaceLocation,
  getOriginalSnapshotPath,
  getRunDir,
  TaskRunFileService,
} from '@utils/files';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installPlatform(
  workspaceDir: string,
  storageRoot: string,
): Promise<void> {
  return installFakePlatform(
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

describe('round-dir ownership and editable .tex inheritance', () => {
  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('snapshots editable .tex on mirror, points r<N>/ symlinks at the snapshot, and the round-output write replaces the symlink with a real file leaving snapshot and workspace untouched', async () => {
    const tempDir = await makeTempDir('texra-round-ownership-');
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    const draftDir = path.join(workspaceDir, 'Draft');
    const draftAbsolute = path.join(draftDir, 'Draft.tex');
    const workspaceOriginal =
      '\\documentclass{article}\\begin{document}original\\end{document}\n';
    await mkdir(draftDir, { recursive: true });
    await writeFile(draftAbsolute, workspaceOriginal);

    await installPlatform(workspaceDir, storageRoot);

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

    const linkStat = await lstat(roundFilePath);
    expect(linkStat.isSymbolicLink()).toBe(true);
    const linkTarget = await readlink(roundFilePath);
    expect(path.resolve(path.dirname(roundFilePath), linkTarget)).toBe(
      snapshotPath,
    );

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
    const tempDir = await makeTempDir('texra-readonly-mirror-');
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(stylePath, '\\newcommand{\\RR}{\\mathbb{R}}\n');

    await installPlatform(workspaceDir, storageRoot);

    const fileService = new TaskRunFileService('run-2');

    await fileService.mirrorWorkspaceFile(
      createWorkspaceLocation(stylePath, 'macros.sty'),
    );

    const snapshotPath = getOriginalSnapshotPath('run-2', 'macros.sty');
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await fileService.ensureMirroredInRoundDir(1);

    const roundFilePath = path.join(getRunDir('run-2'), 'r1', 'macros.sty');
    const linkStat = await lstat(roundFilePath);
    expect(linkStat.isSymbolicLink()).toBe(true);
    const linkTarget = await readlink(roundFilePath);
    expect(path.resolve(path.dirname(roundFilePath), linkTarget)).toBe(
      path.join(getRunDir('run-2'), 'macros.sty'),
    );
  });

  // Pins ensureMirroredInDiffRoundDir's `diff/r{round}` segment, which
  // (like ensureMirroredInRoundDir's `r{round}`) is now built from the
  // shared workflowOutputRoundDir helper (@shared/constants/workflowOutput)
  // instead of an inlined path.dirname(workflowOutputPath(...)).
  it('mirrors into diff/r<N>/ for the latexdiff round directory', async () => {
    const tempDir = await makeTempDir('texra-diff-round-dir-');
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(stylePath, '\\newcommand{\\RR}{\\mathbb{R}}\n');

    await installPlatform(workspaceDir, storageRoot);

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
