import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs } from '@test/support/tempDirPlatform';
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

vi.mock('@utils/config/configUtils', () => ({
  getConfig: <T>(_key: string, fallback: T) => fallback,
}));

describe('LaTeXdiffService shadow output', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(prefix: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(tempDir);
    return tempDir;
  }

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
    const tempDir = await makeTempDir(prefix);
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
      false,
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
    const tempDir = await makeTempDir('texra-latexdiff-bbl-preamble-');
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
