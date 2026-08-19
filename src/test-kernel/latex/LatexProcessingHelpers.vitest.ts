import { lstat, mkdir, readlink, realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  LatexMediaManager,
  type LatexTrace,
  type MediaWorkspaceState,
} from '@latex/LatexMediaManager';
import { DiffFileProcessor } from '@latex/latexdiff/diffFileProcessor';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import type { FileLocation, ToolConfig } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import {
  createExternalLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { getRunDir } from '@utils/files/runStorageFs';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(),
  resolveLatexDir: vi.fn(),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

// Spy on resolveLatexDir while preserving its real behavior, so tests can
// assert *how many times* the (async) baseDir resolution runs per file
// without changing what it resolves to. This is the regression guard for
// issue #7228: extractFiguresFromFiles and mirrorFigureDependencies used to
// each independently resolve the same baseDir.
vi.mock('@latex/latexParsingUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@latex/latexParsingUtils')>();
  mocks.resolveLatexDir.mockImplementation(actual.resolveLatexDir);
  return { ...actual, resolveLatexDir: mocks.resolveLatexDir };
});

type DiffFileProcessorInternals = {
  processLineByLine(content: string): string;
};

const compilePdfConfig: ToolConfig = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  autoCompileInputPdf: true,
};

const logger: LatexTrace = spiedTrace();

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await cleanupTempDirs(tempDirs);
});

describe('DiffFileProcessor line formatting', () => {
  it('preserves package blank-line insertion order', () => {
    const processed = (
      new DiffFileProcessor() as unknown as DiffFileProcessorInternals
    ).processLineByLine(
      [
        '% !TEX root = main.tex',
        'Here is preamble text from latexdiff',
        '\\documentclass{article}',
        '\\usepackage{tikz}',
        '\\usepackage{pgfplots}',
        '\\providecommand{\\DIFaddbegin}{}',
        '\\RequirePackage[normalem]{ulem}',
        '\\usetikzlibrary{calc}',
        '\\RequirePackage{color}',
        'body',
      ].join('\n'),
    );

    expect(processed).toBe(
      [
        '\\documentclass{article}',
        '',
        '\\usepackage{tikz}',
        '',
        '\\usepackage{pgfplots}',
        '',
        '\\providecommand{\\DIFaddbegin}{}',
        '',
        '\\RequirePackage[normalem]{ulem}',
        '',
        '\\usetikzlibrary{calc}',
        '',
        '\\RequirePackage{color}',
        '',
        'body',
        '',
      ].join('\n'),
    );
  });
});

describe('LatexMediaManager PDF compilation', () => {
  it('filters nullish compile results before adding media files', async () => {
    const workspaceDir = await makeTempDir('texra-latex-media-', tempDirs);
    await installPlatform(
      { workspacePath: workspaceDir },
      { fs: nodeFilesystem },
    );

    const inputPaths = [
      path.join(workspaceDir, 'compiled.tex'),
      path.join(workspaceDir, 'missing-result.tex'),
    ];
    await Promise.all(
      inputPaths.map(async (filePath) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, '\\documentclass{article}\n');
      }),
    );

    const compiledPdfPath = path.join(workspaceDir, 'build', 'compiled.pdf');
    mocks.compileLatex2Pdf.mockImplementation(
      async (file: FileLocation, options: { outputDirectory?: string }) => {
        if (path.basename(file.absolutePath) === 'missing-result.tex') {
          return { ok: false, logTail: 'simulated compile failure' };
        }
        const outputDirectory = options.outputDirectory!;
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(compiledPdfPath, 'compiled pdf');
        return { ok: true };
      },
    );

    const workspaceState = AgentWorkspaceState.create();
    const manager = new LatexMediaManager(logger);
    await manager.processInputFiles(
      inputPaths.map(createExternalLocation),
      workspaceState,
      compilePdfConfig,
    );

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledTimes(2);
    expect(workspaceState.media.files.map((file) => file.absolutePath)).toEqual(
      [compiledPdfPath],
    );
  });
});

type LatexMediaManagerFigureInternals = {
  extractFiguresFromFiles(
    files: FileLocation[],
    workspaceState: MediaWorkspaceState,
  ): Promise<void>;
  mirrorFiguresForFiles(files: FileLocation[]): Promise<void>;
};

describe('LatexMediaManager figure baseDir resolution (issue #7228)', () => {
  async function writeFixture(): Promise<{
    texPath: string;
    figurePath: string;
  }> {
    // Canonicalize up front: on macOS os.tmpdir() lives under a /tmp -> /private/tmp
    // symlink, and resolveLatexDir follows real paths. Without this, the
    // workspace root and the realpath'd baseDir it computes would disagree,
    // and mirrorWorkspaceFile would (correctly, but confusingly for this test)
    // classify the figure as external and skip mirroring it.
    const tempDir = await realpath(
      await makeTempDir('texra-latex-media-', tempDirs),
    );
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    const figureDir = path.join(workspaceDir, 'figures');
    const texPath = path.join(workspaceDir, 'main.tex');
    const figurePath = path.join(figureDir, 'plot.png');

    await mkdir(figureDir, { recursive: true });
    await writeFile(
      texPath,
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\includegraphics{figures/plot.png}',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await writeFile(figurePath, 'fake-png-bytes');

    await installPlatform(
      { workspacePath: workspaceDir },
      {
        fs: nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
      },
    );
    return { texPath, figurePath };
  }

  /** Resolve the symlink `mirrorWorkspaceFile` creates in run storage and
   * assert it points back at the real workspace figure. */
  async function expectFigureMirrored(
    executionId: string,
    figurePath: string,
  ): Promise<void> {
    const mirroredPath = path.join(getRunDir(executionId), 'figures/plot.png');
    const stats = await lstat(mirroredPath);
    expect(stats.isSymbolicLink()).toBe(true);
    const target = await readlink(mirroredPath);
    expect(
      await realpath(path.resolve(path.dirname(mirroredPath), target)),
    ).toBe(await realpath(figurePath));
  }

  it('extractFiguresFromFiles reuses its resolved baseDir instead of re-resolving it in mirrorFigureDependencies', async () => {
    const executionId = 'extract-basedir-dedup';
    const { texPath, figurePath } = await writeFixture();

    const workspaceState = AgentWorkspaceState.create();
    const manager = new LatexMediaManager(
      logger,
      new TaskRunFileService(executionId),
    ) as unknown as LatexMediaManagerFigureInternals;
    await manager.extractFiguresFromFiles(
      [createWorkspaceLocation(texPath, 'main.tex')],
      workspaceState,
    );

    // Before the fix this was 3: once inside extractFigurePathsFromLatex,
    // once in extractFiguresFromFiles, and once more (redundantly) in
    // mirrorFigureDependencies. The mirror call now reuses the baseDir
    // extractFiguresFromFiles already resolved.
    expect(mocks.resolveLatexDir).toHaveBeenCalledTimes(2);

    expect(workspaceState.media.files.map((f) => f.absolutePath)).toEqual([
      figurePath,
    ]);
    await expectFigureMirrored(executionId, figurePath);
  });

  it('mirrorFiguresForFiles (no precomputed baseDir) still resolves and mirrors the correct path', async () => {
    const executionId = 'mirror-basedir-fallback';
    const { texPath, figurePath } = await writeFixture();

    const manager = new LatexMediaManager(
      logger,
      new TaskRunFileService(executionId),
    ) as unknown as LatexMediaManagerFigureInternals;
    await manager.mirrorFiguresForFiles([
      createWorkspaceLocation(texPath, 'main.tex'),
    ]);

    // Unchanged by the fix: mirrorFiguresForFiles has no precomputed baseDir,
    // so mirrorFigureDependencies still resolves it itself (once inside
    // extractFigurePathsFromLatex, once as the fallback resolution).
    expect(mocks.resolveLatexDir).toHaveBeenCalledTimes(2);

    await expectFigureMirrored(executionId, figurePath);
  });
});
