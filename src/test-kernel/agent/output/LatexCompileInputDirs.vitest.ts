// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, type FileSystem } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import {
  resolveWorkspaceSourceDir,
  runCompileCheck,
} from '@agent/output/compileCheck';
import { createOutputState, ensureRoundData } from '@agent/output/outputState';
import type { WorkspaceFs } from '@platform/rootedFs';
import type { RunId, FileLocation } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { createFakeWorkspaceRoots, fakePath } from '@test/support/FakePlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { RunFileService } from '@utils/files/runStorage';

// Local file imports
import {
  compileContext,
  compileFsLayer,
  initLatexPlatform,
  outputFile,
  runDir,
  runStorageFile,
  storagePath,
  workspacePath,
} from './compileCheckTestUtils';

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(
    (): Effect.Effect<{ ok: boolean; logTail?: string }> =>
      Effect.succeed({ ok: true }),
  ),
  hasLatexCompiler: vi.fn((): Effect.Effect<boolean> => Effect.succeed(true)),
  publishCompiledPdfArtifact: vi.fn((): Effect.Effect<null, Error> =>
    Effect.succeed(null),
  ),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

vi.mock('@agent/output/compiledPdfArtifacts', async (importOriginal) => ({
  // Only the publish is mocked; the best-effort recovery that wraps it in
  // `LatexDiffManager` stays real, so the failure case exercises it.
  ...(await importOriginal<
    typeof import('@agent/output/compiledPdfArtifacts')
  >()),
  publishCompiledPdfArtifact: mocks.publishCompiledPdfArtifact,
}));

function createDiffCompiler(runId: RunId, logger: AgentTrace) {
  const manager = new LatexDiffManager(
    false,
    () => ({}),
    logger,
    runId,
    new RunFileService(runId, testWorkspaceRoots()),
    testWorkspaceRoots(),
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
    ): Effect.Effect<unknown, Error, FileSystem.FileSystem | WorkspaceFs>;
  };
}

/** Compiles a successful main-diff.tex for `round` and returns the result. */
function compileDiff(
  runId: RunId,
  referenceLocation: FileLocation,
  round: number,
  sourceLocation: FileLocation,
  trace: AgentTrace = spiedTrace(),
): Effect.Effect<unknown, Error, FileSystem.FileSystem | WorkspaceFs> {
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
    mocks.publishCompiledPdfArtifact
      .mockReset()
      .mockReturnValue(Effect.succeed(null));
  });

  it.live('derives compile-check input dirs from outputFile.source', () =>
    Effect.gen(function* () {
      const runId = 'compile-source-dir' as RunId;
      const texPath = path.join(runDir(runId), 'r1', 'main.tex');
      yield* Effect.promise(() =>
        initLatexPlatform({
          [texPath]:
            '\\documentclass{article}\\begin{document}Hi\\end{document}',
        }),
      );

      const outputState = createOutputState();
      ensureRoundData(outputState, 1).outputs = [
        outputFile(runId, path.join('r1', 'main.tex'), 'Draft/main.tex', 1),
      ];

      yield* runCompileCheck(compileContext(runId, outputState), 1);

      expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
        expect.objectContaining({ absolutePath: texPath }),
        expect.anything(),
        expect.objectContaining({
          extraInputDirs: [path.join(workspacePath, 'Draft')],
        }),
      );
    }).pipe(Effect.provide(compileFsLayer)),
  );

  // The desktop's process roots carry no workspace; each open paper's session
  // does. The check runs on the run's fiber, outside any roots scope, so the
  // setting and the source directory must come from the session roots it is
  // handed, not from the process fallback.
  it.live(
    'reads the compile setting and source dir from the session roots, not the process roots',
    () =>
      Effect.gen(function* () {
        const runId = 'compile-session-roots' as RunId;
        const texPath = path.join(runDir(runId), 'r1', 'main.tex');
        yield* Effect.promise(() =>
          installPlatform({
            files: {
              [texPath]:
                '\\documentclass{article}\\begin{document}Hi\\end{document}',
            },
            storagePath,
            workspacePath: undefined,
            workspaceState: {
              [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: false,
            },
          }),
        );
        const sessionRoots = createFakeWorkspaceRoots({
          storagePath,
          workspacePath,
          workspaceState: {
            [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: true,
            [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: 30_000,
          },
        });

        const outputState = createOutputState();
        ensureRoundData(outputState, 1).outputs = [
          outputFile(runId, path.join('r1', 'main.tex'), 'Draft/main.tex', 1),
        ];

        yield* runCompileCheck(
          { ...compileContext(runId, outputState), roots: sessionRoots },
          1,
        );

        expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
          expect.objectContaining({ absolutePath: texPath }),
          sessionRoots,
          expect.objectContaining({
            extraInputDirs: [path.join(workspacePath, 'Draft')],
          }),
        );
      }).pipe(Effect.provide(compileFsLayer)),
  );

  for (const source of ['', fakePath('external/source/main.tex')]) {
    it.live(
      `falls back to the output location for source ${JSON.stringify(source)}`,
      () =>
        Effect.gen(function* () {
          const runId =
            `compile-output-dir-${source ? 'external' : 'empty'}` as RunId;
          const texPath = path.join(runDir(runId), 'r2', 'Draft', 'main.tex');
          yield* Effect.promise(() =>
            initLatexPlatform({
              [texPath]:
                '\\documentclass{article}\\begin{document}Hi\\end{document}',
            }),
          );

          const outputState = createOutputState();
          ensureRoundData(outputState, 2).outputs = [
            outputFile(runId, path.join('r2', 'Draft', 'main.tex'), source, 2),
          ];

          yield* runCompileCheck(compileContext(runId, outputState), 2);

          expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
            expect.objectContaining({ absolutePath: texPath }),
            expect.anything(),
            expect.objectContaining({
              extraInputDirs: [path.join(workspacePath, 'Draft')],
            }),
          );
        }).pipe(Effect.provide(compileFsLayer)),
    );
  }

  it('resolves workspace and round-storage paths through one owner', async () => {
    const runId = 'shared-source-resolver' as RunId;
    await initLatexPlatform({});

    expect(
      resolveWorkspaceSourceDir(
        testWorkspaceRoots(),
        createWorkspaceLocation(
          path.join(workspacePath, 'Draft', 'main.tex'),
          path.join('Draft', 'main.tex'),
        ),
      ),
    ).toBe(path.join(workspacePath, 'Draft'));
    expect(
      resolveWorkspaceSourceDir(
        testWorkspaceRoots(),
        runStorageFile(runId, path.join('r3', 'Draft', 'main.tex')),
      ),
    ).toBe(path.join(workspacePath, 'Draft'));
    expect(
      resolveWorkspaceSourceDir(
        testWorkspaceRoots(),
        createRunStorageLocation(
          path.join(runDir(runId), 'original', 'r3', 'Draft', 'main.tex'),
          path.join('r3', 'Draft', 'main.tex'),
          runId,
        ),
      ),
    ).toBe(path.join(workspacePath, 'r3', 'Draft'));
    expect(
      resolveWorkspaceSourceDir(
        testWorkspaceRoots(),
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
        testWorkspaceRoots(),
        createExternalLocation(fakePath('external/project/main.tex')),
      ),
    ).toBeUndefined();
  });

  it('returns no workspace source directory when no workspace is open', async () => {
    await installPlatform({ storagePath, workspacePath: undefined });

    expect(
      resolveWorkspaceSourceDir(
        testWorkspaceRoots(),
        createWorkspaceLocation(
          path.join(workspacePath, 'Draft', 'main.tex'),
          path.join('Draft', 'main.tex'),
        ),
      ),
    ).toBeUndefined();
  });

  it.live(
    'compiles diffs with revised round inputs before workspace fallbacks',
    () =>
      Effect.gen(function* () {
        const runId = 'latexdiff-input-dir' as RunId;
        yield* Effect.promise(() => initLatexPlatform({}));

        yield* compileDiff(
          runId,
          runStorageFile(runId, path.join('r1', 'Draft', 'main.tex')),
          2,
          runStorageFile(runId, path.join('r2', 'Draft', 'main.tex')),
        );

        expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
          expect.objectContaining({
            absolutePath: path.join(
              runDir(runId),
              'diff',
              'r2',
              'main-diff.tex',
            ),
          }),
          expect.anything(),
          expect.objectContaining({
            extraInputDirs: [
              path.join(runDir(runId), 'r2', 'Draft'),
              path.join(workspacePath, 'Draft'),
            ],
          }),
        );
      }).pipe(Effect.provide(compileFsLayer)),
  );

  it.live('keeps an external latexdiff reference in its own directory', () =>
    Effect.gen(function* () {
      const runId = 'latexdiff-external-input-dir' as RunId;
      yield* Effect.promise(() => initLatexPlatform({}));

      yield* compileDiff(
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
        expect.anything(),
        expect.objectContaining({
          extraInputDirs: [fakePath('external/project')],
        }),
      );
    }).pipe(Effect.provide(compileFsLayer)),
  );

  it.live('keeps a successful diff when publishing its PDF fails', () =>
    Effect.gen(function* () {
      const runId = 'latexdiff-publish-failure' as RunId;
      yield* Effect.promise(() => initLatexPlatform({}));
      const trace = spiedTrace();
      const publishError = new Error('artifact storage unavailable');
      mocks.publishCompiledPdfArtifact.mockReturnValueOnce(
        Effect.fail(publishError),
      );

      const result = yield* compileDiff(
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
    }).pipe(Effect.provide(compileFsLayer)),
  );

  it.live(
    'keeps a failed latexdiff compiler transcript out of the warning message',
    () =>
      Effect.gen(function* () {
        const runId = 'latexdiff-compile-failure' as RunId;
        yield* Effect.promise(() => initLatexPlatform({}));
        const trace = spiedTrace();
        const logTail =
          'LaTeX compiler transcript that should remain diagnostic';
        mocks.compileLatex2Pdf.mockReturnValueOnce(
          Effect.succeed({ ok: false, logTail }),
        );

        yield* compileDiff(
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
      }).pipe(Effect.provide(compileFsLayer)),
  );
});
