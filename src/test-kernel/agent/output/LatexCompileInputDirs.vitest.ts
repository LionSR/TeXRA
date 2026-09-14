// Node imports
import * as path from 'node:path';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { LatexDiffManager } from '@agent/implementations/flows/reflection/output/LatexDiffManager';
import {
  resolveWorkspaceSourceDir,
  runCompileCheck,
} from '@agent/implementations/flows/reflection/output/compileCheck';
import {
  createOutputState,
  ensureRoundData,
} from '@agent/implementations/flows/reflection/output/outputState';
import type { RunId, FileLocation } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

// Local file imports
import {
  compileContext,
  initLatexPlatform,
  outputFile,
  runDir,
  runStorageFile,
  storagePath,
  workspacePath,
} from './compileCheckTestUtils';

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(
    async (): Promise<{ ok: boolean; logTail?: string }> => ({ ok: true }),
  ),
  hasLatexCompiler: vi.fn(async () => true),
  publishCompiledPdfArtifact: vi.fn(async () => null),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

vi.mock(
  '@agent/implementations/flows/reflection/output/compiledPdfArtifacts',
  () => ({
    publishCompiledPdfArtifact: mocks.publishCompiledPdfArtifact,
  }),
);

function createDiffCompiler(runId: RunId, logger: AgentTrace) {
  const manager = new LatexDiffManager(
    false,
    () => ({}),
    logger,
    runId,
    new TaskRunFileService(runId),
  );

  return manager as unknown as {
    compileDiffIfSuccessful(
      result: { success: boolean; diffPath?: string },
      referenceLocation: FileLocation,
      diffDirectory: {
        absolutePath: string;
        relativePath: string;
        runId: RunId;
      },
      round: number,
      sourceLocation: FileLocation,
      pdfStemSuffix: string,
    ): Promise<unknown>;
  };
}

/** Compiles a successful main-diff.tex for `round` and returns the result. */
async function compileDiff(
  runId: RunId,
  referenceLocation: FileLocation,
  round: number,
  sourceLocation: FileLocation,
  trace: AgentTrace = spiedTrace(),
): Promise<unknown> {
  const diffAbsoluteDir = path.join(runDir(runId), 'diff', `r${round}`);
  return createDiffCompiler(runId, trace).compileDiffIfSuccessful(
    { success: true, diffPath: path.join(diffAbsoluteDir, 'main-diff.tex') },
    referenceLocation,
    {
      absolutePath: diffAbsoluteDir,
      relativePath: path.join('diff', `r${round}`),
      runId,
    },
    round,
    sourceLocation,
    '-diff',
  );
}

describe('workflow LaTeX compile input directories', () => {
  beforeEach(() => {
    mocks.compileLatex2Pdf.mockClear();
    mocks.hasLatexCompiler.mockClear();
    mocks.publishCompiledPdfArtifact.mockReset().mockResolvedValue(null);
  });

  it('derives compile-check input dirs from outputFile.source', async () => {
    const runId = 'compile-source-dir' as RunId;
    const texPath = path.join(runDir(runId), 'r1', 'main.tex');
    await initLatexPlatform({
      [texPath]: '\\documentclass{article}\\begin{document}Hi\\end{document}',
    });

    const outputState = createOutputState();
    ensureRoundData(outputState, 1).outputs = [
      outputFile(runId, path.join('r1', 'main.tex'), 'Draft/main.tex', 1),
    ];

    await runCompileCheck(compileContext(runId, outputState), 1);

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: texPath }),
      expect.objectContaining({
        extraInputDirs: [path.join(workspacePath, 'Draft')],
      }),
    );
  });

  it.each(['', fakePath('external/source/main.tex')])(
    'falls back to the output location for source %j',
    async (source) => {
      const runId =
        `compile-output-dir-${source ? 'external' : 'empty'}` as RunId;
      const texPath = path.join(runDir(runId), 'r2', 'Draft', 'main.tex');
      await initLatexPlatform({
        [texPath]: '\\documentclass{article}\\begin{document}Hi\\end{document}',
      });

      const outputState = createOutputState();
      ensureRoundData(outputState, 2).outputs = [
        outputFile(runId, path.join('r2', 'Draft', 'main.tex'), source, 2),
      ];

      await runCompileCheck(compileContext(runId, outputState), 2);

      expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
        expect.objectContaining({ absolutePath: texPath }),
        expect.objectContaining({
          extraInputDirs: [path.join(workspacePath, 'Draft')],
        }),
      );
    },
  );

  it('resolves workspace and round-storage paths through one owner', async () => {
    const runId = 'shared-source-resolver' as RunId;
    await initLatexPlatform({});

    expect(
      resolveWorkspaceSourceDir(
        createWorkspaceLocation(
          path.join(workspacePath, 'Draft', 'main.tex'),
          path.join('Draft', 'main.tex'),
        ),
      ),
    ).toBe(path.join(workspacePath, 'Draft'));
    expect(
      resolveWorkspaceSourceDir(
        runStorageFile(runId, path.join('r3', 'Draft', 'main.tex')),
      ),
    ).toBe(path.join(workspacePath, 'Draft'));
    expect(
      resolveWorkspaceSourceDir(
        createRunStorageLocation(
          path.join(runDir(runId), 'original', 'r3', 'Draft', 'main.tex'),
          path.join('r3', 'Draft', 'main.tex'),
          runId,
        ),
      ),
    ).toBe(path.join(workspacePath, 'r3', 'Draft'));
    expect(
      resolveWorkspaceSourceDir(
        createWorkspaceLocation(
          path.join(workspacePath, 'r3', 'Draft', 'main.tex'),
          path.join('r3', 'Draft', 'main.tex'),
        ),
      ),
    ).toBe(path.join(workspacePath, 'r3', 'Draft'));
  });

  it('does not map external locations into the workspace', async () => {
    await initLatexPlatform({});

    expect(
      resolveWorkspaceSourceDir(
        createExternalLocation(fakePath('external/project/main.tex')),
      ),
    ).toBeUndefined();
  });

  it('returns no workspace source directory when no workspace is open', async () => {
    await installPlatform({ storagePath, workspacePath: undefined });

    expect(
      resolveWorkspaceSourceDir(
        createWorkspaceLocation(
          path.join(workspacePath, 'Draft', 'main.tex'),
          path.join('Draft', 'main.tex'),
        ),
      ),
    ).toBeUndefined();
  });

  it('compiles diffs with revised round inputs before workspace fallbacks', async () => {
    const runId = 'latexdiff-input-dir' as RunId;
    await initLatexPlatform({});

    await compileDiff(
      runId,
      runStorageFile(runId, path.join('r1', 'Draft', 'main.tex')),
      2,
      runStorageFile(runId, path.join('r2', 'Draft', 'main.tex')),
    );

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: path.join(runDir(runId), 'diff', 'r2', 'main-diff.tex'),
      }),
      expect.objectContaining({
        extraInputDirs: [
          path.join(runDir(runId), 'r2', 'Draft'),
          path.join(workspacePath, 'Draft'),
        ],
      }),
    );
  });

  it('keeps an external latexdiff reference in its own directory', async () => {
    const runId = 'latexdiff-external-input-dir' as RunId;
    await initLatexPlatform({});

    await compileDiff(
      runId,
      createExternalLocation(fakePath('external/project/main.tex')),
      1,
      createWorkspaceLocation(
        path.join(workspacePath, 'Draft', 'main.tex'),
        path.join('Draft', 'main.tex'),
      ),
    );

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extraInputDirs: [fakePath('external/project')],
      }),
    );
  });

  it('keeps a successful diff when publishing its PDF fails', async () => {
    const runId = 'latexdiff-publish-failure' as RunId;
    await initLatexPlatform({});
    const trace = spiedTrace();
    const publishError = new Error('artifact storage unavailable');
    mocks.publishCompiledPdfArtifact.mockRejectedValueOnce(publishError);

    const result = await compileDiff(
      runId,
      runStorageFile(runId, path.join('r1', 'main.tex')),
      2,
      runStorageFile(runId, path.join('r2', 'main.tex')),
      trace,
    );

    expect(result).toEqual(expect.objectContaining({ artifact: null }));
    expect(trace.warn).toHaveBeenCalledWith(
      'Failed to publish latexdiff PDF: artifact storage unavailable',
      expect.objectContaining({
        data: expect.objectContaining({ error: publishError }),
      }),
    );
  });

  it('keeps a failed latexdiff compiler transcript out of the warning message', async () => {
    const runId = 'latexdiff-compile-failure' as RunId;
    await initLatexPlatform({});
    const trace = spiedTrace();
    const logTail = 'LaTeX compiler transcript that should remain diagnostic';
    mocks.compileLatex2Pdf.mockResolvedValueOnce({ ok: false, logTail });

    await compileDiff(
      runId,
      runStorageFile(runId, path.join('r1', 'main.tex')),
      2,
      runStorageFile(runId, path.join('r2', 'main.tex')),
      trace,
    );

    expect(trace.warn).toHaveBeenCalledWith(
      'Failed to compile latexdiff PDF: main-diff.tex',
      expect.objectContaining({
        data: expect.objectContaining({ logTail }),
      }),
    );
    expect(trace.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(logTail),
      expect.anything(),
    );
  });
});
