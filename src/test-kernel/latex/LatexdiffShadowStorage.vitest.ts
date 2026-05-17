import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { createWorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
import {
  createExternalLocation,
  createWorkspaceLocation,
  getRunDir,
  TaskRunFileService,
} from '@utils/files';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock('@utils/system', () => ({
  executeCommand: mocks.executeCommand,
}));

vi.mock('@agent/core/stateStore', () => ({
  getWorkspaceState: () => ({
    get: <T>(_key: unknown, fallback: T) => fallback,
  }),
  tryGetWorkspaceState: () => ({
    get: <T>(_key: unknown, fallback: T) => fallback,
  }),
}));

vi.mock('@agent/core/config', () => ({
  getConfig: <T>(_key: string, fallback: T) => fallback,
}));

describe('LaTeXdiffService shadow output', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(prefix: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

  async function installNodeBackedPlatform(
    workspaceDir: string,
    storageRoot: string,
  ): Promise<void> {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform(
        {
          workspacePath: workspaceDir,
        },
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

  beforeEach(() => {
    mocks.executeCommand.mockResolvedValue({
      success: true,
      stdout:
        '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n',
      stderr: '',
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('writes generated diff sources to the requested output directory', async () => {
    const { LaTeXdiffService } = await import('@latex/latexdiff');
    const tempDir = await makeTempDir('texra-latexdiff-');
    const sourceDir = path.join(tempDir, 'workspace');
    const shadowDir = path.join(tempDir, 'executions', 'run-1', 'diff', 'r1');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      path.join(sourceDir, 'base.tex'),
      '\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n',
    );
    await writeFile(
      path.join(sourceDir, 'revised.tex'),
      '\\documentclass{article}\n\\begin{document}\nnew\n\\end{document}\n',
    );
    await installNodeBackedPlatform(sourceDir, path.join(tempDir, 'storage'));

    const service = new LaTeXdiffService('test');
    const result = await service.runDiff(
      createExternalLocation(path.join(sourceDir, 'base.tex')),
      createExternalLocation(path.join(sourceDir, 'revised.tex')),
      '_diff',
      false,
      undefined,
      { outputDirectory: shadowDir },
    );

    expect(result).toMatchObject({ success: true });
    expect(result.diffFileName).toBe('revised_diff.tex');
    await expect(
      readFile(path.join(shadowDir, 'revised_diff.tex'), 'utf8'),
    ).resolves.toContain('changed');
    await expect(
      readFile(path.join(sourceDir, 'revised_diff.tex'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mirrors workspace dependencies into diff round storage', async () => {
    const tempDir = await makeTempDir('texra-diff-mirror-');
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    const dependencyPath = path.join(workspaceDir, 'refs', 'macros.sty');
    await mkdir(path.dirname(dependencyPath), { recursive: true });
    await writeFile(dependencyPath, '\\newcommand{\\RR}{\\mathbb{R}}\n');

    await installNodeBackedPlatform(workspaceDir, storageRoot);

    const fileService = new TaskRunFileService('run-1');
    await fileService.mirrorWorkspaceFile(
      createWorkspaceLocation(dependencyPath, 'refs/macros.sty'),
    );

    await fileService.ensureMirroredInDiffRoundDir(2);

    await expect(
      readFile(
        path.join(getRunDir('run-1'), 'diff', 'r2', 'refs', 'macros.sty'),
        'utf8',
      ),
    ).resolves.toBe('\\newcommand{\\RR}{\\mathbb{R}}\n');
  });
});
