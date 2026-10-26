// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, type FileSystem } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import type { WorkspaceFs } from '@platform/rootedFs';
import {
  fileLocationDisplayPath,
  type RunId,
  type FileLocation,
} from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { createFakeWorkspaceRoots, fakePath } from '@test/support/FakePlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import {
  createOutputState,
  ensureRoundData,
} from '@texra/agent/output/outputState';
import {
  resolveWorkspaceSourceDir,
  runCompileCheck,
} from '@texra/agent/output/compileCheck';
import { LatexDiffManager } from '@texra/agent/output/LatexDiffManager';
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
  // The latexdiff process edge: its probe and its run.
  checkToolInstalled: vi.fn((): Effect.Effect<boolean> => Effect.succeed(true)),
  executeCommand: vi.fn(() =>
    Effect.succeed({
      success: true,
      stdout:
        '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n',
      stderr: '',
    }),
  ),
}));

vi.mock('@texra/utils/system/toolChecks', () => ({
  checkToolInstalled: mocks.checkToolInstalled,
}));

vi.mock('@utils/system/execUtils', () => ({
  executeCommand: mocks.executeCommand,
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

vi.mock('@texra/agent/output/compiledPdfArtifacts', async (importOriginal) => ({
  // Only the publish is mocked: no PDF is ever written here.
  ...(await importOriginal<
    typeof import('@texra/agent/output/compiledPdfArtifacts')
  >()),
  publishCompiledPdfArtifact: mocks.publishCompiledPdfArtifact,
}));

function createDiffCompiler(runId: RunId, logger: AgentTrace) {
  const manager = new LatexDiffManager(
    logger,
    runId,
    new RunFileService(runId, testWorkspaceRoots()),
    testWorkspaceRoots(),
  );

  return manager as unknown as {
    compileDiff(
      diffPath: string,
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
): Effect.Effect<unknown, Error, FileSystem.FileSystem | WorkspaceFs> {
  const diffAbsoluteDir = path.join(runDir(runId), 'diff', `r${round}`);
  return createDiffCompiler(runId, spiedTrace()).compileDiff(
    path.join(diffAbsoluteDir, 'main-diff.tex'),
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
  // Two documents sharing a file name: each pair's diff once landed on the
  // same flat `diff/r1/main_diff.tex`, the second overwriting the first.
  it.live("writes each document's latexdiffs under its own folder", () =>
    Effect.gen(function* () {
      const runId = 'latexdiff-same-basename' as RunId;
      const document = (body: string) =>
        `\\documentclass{article}\\begin{document}${body}\\end{document}`;
      const files = ['original', 'r0', 'r1'].flatMap((dir) =>
        ['a', 'b'].map((folder) => path.join(dir, folder, 'main.tex')),
      );
      yield* Effect.promise(() =>
        installPlatform({
          files: Object.fromEntries(
            files.map((file) => [
              path.join(runDir(runId), file),
              document(file),
            ]),
          ),
          storagePath,
          workspacePath,
          workspaceState: {
            [DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS]: true,
          },
        }),
      );
      const output = (round: number, folder: string): OutputFileInfo => ({
        source: `${folder}/main.tex`,
        round,
        location: runStorageFile(
          runId,
          path.join(`r${round}`, folder, 'main.tex'),
        ),
        lineage: {
          original: null,
          diffBase: runStorageFile(
            runId,
            path.join('original', folder, 'main.tex'),
          ),
        },
        diff: null,
      });
      const manager = new LatexDiffManager(
        spiedTrace(),
        runId,
        new RunFileService(runId, testWorkspaceRoots()),
        testWorkspaceRoots(),
      );

      const { entries } = yield* manager.handleLatexdiffOfOutput(
        1,
        [output(1, 'a'), output(1, 'b')],
        [output(0, 'a'), output(0, 'b')],
      );

      expect(
        entries.map((entry) =>
          entry.status === 'ok'
            ? fileLocationDisplayPath(entry.diff)
            : entry.error,
        ),
      ).toStrictEqual([
        path.join('diff', 'r1', 'a', 'main_diff.tex'),
        path.join('diff', 'r1', 'b', 'main_diff.tex'),
        path.join('diff', 'r1', 'a', 'main_diffr1r0.tex'),
        path.join('diff', 'r1', 'b', 'main_diffr1r0.tex'),
      ]);
    }).pipe(Effect.provide(compileFsLayer)),
  );

  beforeEach(() => {
    mocks.compileLatex2Pdf.mockClear();
    mocks.hasLatexCompiler.mockClear();
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
              [DocumentsStateKey.WORKFLOW_AUTO_COMPILE]: false,
            },
          }),
        );
        const sessionRoots = createFakeWorkspaceRoots({
          storagePath,
          workspacePath,
          workspaceState: {
            [DocumentsStateKey.WORKFLOW_AUTO_COMPILE]: true,
            [DocumentsStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: 30_000,
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
});
