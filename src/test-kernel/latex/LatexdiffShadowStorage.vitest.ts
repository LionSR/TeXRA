import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as logger from '@logger/logUtils';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import type { ExecutionId, OutputFileInfo } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { getRunDir } from '@utils/files/runStorageFs';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock('@utils/system/execUtils', () => ({
  executeCommand: mocks.executeCommand,
}));

vi.mock('@utils/config/configUtils', () => ({
  getConfig: <T>(_key: string, fallback: T) => fallback,
}));

describe('LaTeXdiffService shadow output', () => {
  const tempDirs: string[] = [];

  function installNodeBackedPlatform(
    workspaceDir: string,
    storageRoot: string,
  ): Promise<void> {
    return installPlatform(
      {
        workspacePath: workspaceDir,
      },
      {
        fs: nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
        globalState: new MemoryStateStore(),
        workspaceState: new MemoryStateStore(),
      },
    );
  }

  // Shared setup for the two runDiff tests: write base/revised sources into a
  // fresh workspace, install the node-backed platform, and return the source
  // and shadow output directories.
  async function prepareDiffWorkspace(
    prefix: string,
    baseContent: string,
    revisedContent: string,
  ): Promise<{ sourceDir: string; shadowDir: string }> {
    const tempDir = await makeTempDir(prefix, tempDirs);
    const sourceDir = path.join(tempDir, 'workspace');
    const shadowDir = path.join(tempDir, 'executions', 'run-1', 'diff', 'r1');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'base.tex'), baseContent);
    await writeFile(path.join(sourceDir, 'revised.tex'), revisedContent);
    await installNodeBackedPlatform(sourceDir, path.join(tempDir, 'storage'));
    return { sourceDir, shadowDir };
  }

  async function runShadowDiff(sourceDir: string, shadowDir: string) {
    const { LaTeXdiffService } = await import('@latex/latexdiff');
    const service = new LaTeXdiffService('test');
    return service.runDiff(
      createExternalLocation(path.join(sourceDir, 'base.tex')),
      createExternalLocation(path.join(sourceDir, 'revised.tex')),
      '_diff',
      undefined,
      { outputDirectory: shadowDir },
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
    await cleanupTempDirs(tempDirs);
  });

  it('writes generated diff sources to the requested output directory', async () => {
    const { sourceDir, shadowDir } = await prepareDiffWorkspace(
      'texra-latexdiff-',
      '\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n',
      '\\documentclass{article}\n\\begin{document}\nnew\n\\end{document}\n',
    );

    const result = await runShadowDiff(sourceDir, shadowDir);

    expect(result).toMatchObject({ success: true });
    expect(result.diffFileName).toBe('revised_diff.tex');
    await expect(
      readFile(path.join(shadowDir, 'revised_diff.tex'), 'utf8'),
    ).resolves.toContain('changed');
    await expect(
      readFile(path.join(sourceDir, 'revised_diff.tex'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('generates between-round diffs for modern run-storage paths', async () => {
    const tempDir = await makeTempDir('texra-latexdiff-rounds-', tempDirs);
    const workspaceDir = path.join(tempDir, 'workspace');
    const executionId: ExecutionId = 'abcdef';
    const firstDir = path.join(tempDir, 'executions', executionId, 'r1');
    const secondDir = path.join(tempDir, 'executions', executionId, 'r2');
    const basePath = path.join(workspaceDir, 'paper.tex');
    const firstPath = path.join(firstDir, 'paper.tex');
    const secondPath = path.join(secondDir, 'paper.tex');
    const document = (body: string) =>
      `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(firstDir, { recursive: true }),
      mkdir(secondDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(basePath, document('base')),
      writeFile(firstPath, document('round one')),
      writeFile(secondPath, document('round two')),
    ]);
    await installNodeBackedPlatform(
      workspaceDir,
      path.join(tempDir, 'storage'),
    );

    const base = createWorkspaceLocation(basePath, 'paper.tex');
    const first = createRunStorageLocation(
      firstPath,
      'r1/paper.tex',
      executionId,
    );
    const second = createRunStorageLocation(
      secondPath,
      'r2/paper.tex',
      executionId,
    );
    const output = (
      round: number,
      location: typeof first,
      source = 'paper.tex',
    ): OutputFileInfo => ({
      source,
      location,
      round,
      lineage: { original: base, diffBase: null, diffFile: null },
      diff: null,
    });
    const { runLatexdiffFromMetadata } =
      await import('@latex/latexdiff/diffOperations');

    const { LaTeXdiffService } = await import('@latex/latexdiff');
    const result = await runLatexdiffFromMetadata({
      rounds: { 1: [output(1, first)], 2: [output(2, second, './paper.tex')] },
      generateBetweenRoundDiffs: true,
      latexdiff: {
        channel: 'test',
        service: new LaTeXdiffService('test'),
      },
      progress: { report: vi.fn() },
    });

    expect(result.results).toHaveLength(3);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          success: true,
          description: 'paper.tex (r1→r2)',
          diffFileName: 'paper_diffr2r1.tex',
        }),
      ]),
    );
    await expect(
      readFile(path.join(firstDir, 'paper_diffr2r1.tex'), 'utf8'),
    ).resolves.toContain('changed');
  });

  it('restores flattened BibTeX blocks to the source bibliography directive', async () => {
    const { sourceDir, shadowDir } = await prepareDiffWorkspace(
      'texra-latexdiff-bib-',
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'old \\cite{a}',
        '\\bibliographystyle{plain}',
        '\\bibliography{library}',
        '\\end{document}',
        '',
      ].join('\n'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'new \\cite{a}',
        '\\bibliographystyle{plain}',
        '\\bibliography{library}',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    mocks.executeCommand.mockResolvedValueOnce({
      success: true,
      stdout: [
        '\\documentclass{article}',
        '\\begin{document}',
        'new \\cite{a}',
        '\\bibliographystyle{plain}',
        '\\begin{thebibliography}{}',
        '\\providecommand \\@ifxundefined [\\DIFadd{1}]{% corrupted bbl macro',
        '\\end{thebibliography}',
        '\\end{document}',
        '',
      ].join('\n'),
      stderr: '',
    });

    const result = await runShadowDiff(sourceDir, shadowDir);

    expect(result).toMatchObject({ success: true });
    const diff = await readFile(
      path.join(shadowDir, 'revised_diff.tex'),
      'utf8',
    );
    expect(diff).toContain('\\bibliography{library}');
    expect(diff).not.toContain('\\begin{thebibliography}');
    expect(diff).not.toContain('\\DIFadd{1}');
  });

  it('sanitizes latexdiff markers from flattened bibliography macro preambles', async () => {
    const { DiffFileProcessor } =
      await import('@latex/latexdiff/diffFileProcessor');
    const tempDir = await makeTempDir(
      'texra-latexdiff-bbl-preamble-',
      tempDirs,
    );
    const sourceDir = path.join(tempDir, 'workspace');
    await mkdir(sourceDir, { recursive: true });
    await installNodeBackedPlatform(sourceDir, path.join(tempDir, 'storage'));
    const diffPath = path.join(sourceDir, 'main-diff.tex');
    await writeFile(
      diffPath,
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{thebibliography}{}',
        '\\makeatletter',
        '\\providecommand \\@ifxundefined [\\DIFadd{1}]{%DIF >',
        ' \\@ifx{#1\\undefined}',
        '}%DIF >',
        '\\providecommand \\@ifnum [\\DIFadd{1}]{%DIF >',
        ' \\ifnum \\DIFadd{#1}\\expandafter \\@firstoftwo',
        ' \\else \\expandafter \\@secondoftwo',
        ' \\fi',
        '}%DIF >',
        '\\providecommand \\DIFadd{\\mbox{%DIFAUXCMD',
        '\\citenamefont }\\hskip0pt%DIFAUXCMD',
        '}[\\DIFadd{1}]{\\DIFadd{#1}}%DIF >',
        '\\providecommand \\DIFadd{\\bibinfo  }[\\DIFadd{0}]{\\@secondoftwo}%DIF >',
        '\\bibitem{sample}',
        '\\DIFadd{added citation text}',
        '\\end{thebibliography}',
        '\\end{document}',
        '',
      ].join('\n'),
    );

    await new DiffFileProcessor().processDiffFile(
      createExternalLocation(diffPath),
    );

    const diff = await readFile(diffPath, 'utf8');
    expect(diff).toContain('\\providecommand \\@ifxundefined [1]{%');
    expect(diff).toContain('\\ifnum #1\\expandafter \\@firstoftwo');
    expect(diff).toContain('\\providecommand \\citenamefont [1]{#1}%');
    expect(diff).toContain('\\providecommand \\bibinfo  [0]{\\@secondoftwo}%');
    expect(diff).toContain('\\DIFadd{added citation text}');
    expect(diff).not.toContain('\\DIFadd{1}');
    expect(diff).not.toContain('DIFAUXCMD');
    expect(diff).not.toContain('\\providecommand \\DIFadd');
  });

  it('mirrors workspace dependencies into diff round storage', async () => {
    const tempDir = await makeTempDir('texra-diff-mirror-', tempDirs);
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

describe('LaTeXdiffService logger channel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Spy seam (#10635): the owner getter binds the constructor channel through
  // createLog per call, so a logger-namespace spy must observe that channel.
  it('binds log lines to the constructor channel', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { LaTeXdiffService } = await import('@latex/latexdiff');
    const service = new LaTeXdiffService('pinnedLatexdiffChannel');

    const result = await service.runDiff(
      createExternalLocation('/missing/base.tex'),
      createExternalLocation('/missing/revised.tex'),
    );

    expect(result.success).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'pinnedLatexdiffChannel',
      expect.stringContaining('One or both files do not exist'),
    );
  });
});
