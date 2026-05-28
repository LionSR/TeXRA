import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { createWorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
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

async function installPlatform(
  workspaceDir: string,
  storageRoot: string,
): Promise<void> {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform(
      { workspacePath: workspaceDir },
      {
        fs: nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: createWorkspaceStorageProvider(storageRoot, workspaceDir),
        globalState: createMemoryStore(),
        workspaceState: createMemoryStore(),
      },
    ),
  );
}

describe('round-dir ownership and editable .tex inheritance', () => {
  beforeEach(() => {
    // empty
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
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

    // Editable input: mirror with snapshot=true (the path
    // mirrorLatexFileDependencies takes for .tex deps).
    await fileService.mirrorWorkspaceFile(
      createWorkspaceLocation(draftAbsolute, 'Draft/Draft.tex'),
      { snapshot: true },
    );

    const snapshotPath = getOriginalSnapshotPath('run-1', 'Draft/Draft.tex');
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );

    // Stage round 1 working tree.
    await fileService.ensureMirroredInRoundDir(1);

    const roundFilePath = path.join(
      getRunDir('run-1'),
      'r1',
      'Draft',
      'Draft.tex',
    );

    // Symlink target must point at the immutable snapshot, not at the
    // workspace mirror that chains back to the user's file.
    const linkStat = await lstat(roundFilePath);
    expect(linkStat.isSymbolicLink()).toBe(true);
    const linkTarget = await readlink(roundFilePath);
    expect(path.resolve(path.dirname(roundFilePath), linkTarget)).toBe(
      snapshotPath,
    );

    // Simulate XmlOutputManager.writeRoundOutput: lstat → unlink-if-symlink
    // → write. This is the round-N ownership handoff.
    const roundOneContent =
      '\\documentclass{article}\\begin{document}round 1\\end{document}\n';
    const pre = await lstat(roundFilePath);
    if (pre.isSymbolicLink()) await unlink(roundFilePath);
    await AbsoluteFS.write(roundFilePath, roundOneContent);

    // r1/Draft/Draft.tex is now a real file owned by round 1.
    const post = await lstat(roundFilePath);
    expect(post.isSymbolicLink()).toBe(false);
    expect(post.isFile()).toBe(true);
    await expect(readFile(roundFilePath, 'utf8')).resolves.toBe(
      roundOneContent,
    );

    // Snapshot is intact — never written through.
    await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
      workspaceOriginal,
    );

    // User's workspace file is untouched.
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

    // Mirror without snapshot — represents cls/sty/bib/figure deps.
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
    // Falls through to the workspace mirror at runDir/<rel>.
    expect(path.resolve(path.dirname(roundFilePath), linkTarget)).toBe(
      path.join(getRunDir('run-2'), 'macros.sty'),
    );
  });
});
