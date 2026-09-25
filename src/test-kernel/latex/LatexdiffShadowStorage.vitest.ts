import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import type { RunId, OutputFileInfo } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import { runDirUnder } from '@utils/files/runStorageFs';
import { RunFileService } from '@utils/files/runStorage';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock('@utils/system/execUtils', () => ({
  executeCommand: mocks.executeCommand,
}));

describe('LaTeXdiffService shadow output', () => {
  const tempDirs = useTempDirs();

  function installNodeBackedPlatform(
    workspaceDir: string,
    storageRoot: string,
  ): Promise<void> {
    return installPlatform(
      {
        workspacePath: workspaceDir,
        storagePath: resolveWorkspaceStoragePath(storageRoot, workspaceDir),
        globalStoragePath: resolveGlobalStoragePath(storageRoot),
      },
      {
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

  const runShadowDiff = Effect.fn('runShadowDiff')(function* (
    sourceDir: string,
    shadowDir: string,
  ) {
    const { LaTeXdiffService } = yield* Effect.promise(
      () => import('@latex/latexdiff'),
    );
    return yield* new LaTeXdiffService('test', testWorkspaceRoots()).runDiff(
      createExternalLocation(path.join(sourceDir, 'base.tex')),
      createExternalLocation(path.join(sourceDir, 'revised.tex')),
      '_diff',
      undefined,
      { cwd: testWorkspaceRoots().workspace, outputDirectory: shadowDir },
    );
  });

  beforeEach(() => {
    mocks.executeCommand.mockReturnValue(
      Effect.succeed({
        success: true,
        stdout:
          '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n',
        stderr: '',
      }),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  it.effect(
    'writes generated diff sources to the requested output directory',
    () =>
      Effect.gen(function* () {
        const { sourceDir, shadowDir } = yield* Effect.promise(() =>
          prepareDiffWorkspace(
            'texra-latexdiff-',
            '\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n',
            '\\documentclass{article}\n\\begin{document}\nnew\n\\end{document}\n',
          ),
        );

        const result = yield* runShadowDiff(sourceDir, shadowDir);

        if (!result.success) {
          throw new Error(`Expected diff run to succeed: ${result.message}`);
        }
        expect(path.basename(result.diffPath)).toBe('revised_diff.tex');
        expect(
          yield* Effect.promise(() =>
            readFile(path.join(shadowDir, 'revised_diff.tex'), 'utf8'),
          ),
        ).toContain('changed');
        // The diff must not land beside the sources.
        expect(
          yield* Effect.promise(() =>
            readFile(path.join(sourceDir, 'revised_diff.tex'), 'utf8').then(
              () => null,
              (error: NodeJS.ErrnoException) => error.code,
            ),
          ),
        ).toBe('ENOENT');
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  // A run holds its session roots as data: on the desktop they differ from
  // the process roots, and the run's fiber can leave the session's roots
  // scope (#12433), so a round diff must read the session's settings.
  it.live(
    'reads latexdiff settings from the session roots it is handed, not the process roots',
    () =>
      Effect.gen(function* () {
        const { sourceDir, shadowDir } = yield* Effect.promise(() =>
          prepareDiffWorkspace(
            'texra-latexdiff-session-',
            '\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n',
            '\\documentclass{article}\n\\begin{document}\nnew\n\\end{document}\n',
          ),
        );
        const sessionRoots = {
          ...testWorkspaceRoots(),
          workspaceState: new MemoryStateStore(),
        };
        yield* testWorkspaceRoots().workspaceState.update(
          WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          'coarse',
        );
        yield* sessionRoots.workspaceState.update(
          WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
          'off',
        );
        const { LaTeXdiffService } = yield* Effect.promise(
          () => import('@latex/latexdiff'),
        );

        yield* new LaTeXdiffService('test', sessionRoots).runDiffForRound(
          createExternalLocation(path.join(sourceDir, 'base.tex')),
          createExternalLocation(path.join(sourceDir, 'revised.tex')),
          1,
          undefined,
          { cwd: sessionRoots.workspace, outputDirectory: shadowDir },
        );

        expect(mocks.executeCommand).toHaveBeenCalledWith(
          expect.arrayContaining(['--math-markup=off']),
          expect.anything(),
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect('generates between-round diffs for modern run-storage paths', () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        makeTempDir('texra-latexdiff-rounds-', tempDirs),
      );
      const workspaceDir = path.join(tempDir, 'workspace');
      const runId = 'abcdef' as RunId;
      const firstDir = path.join(tempDir, 'executions', runId, 'r1');
      const secondDir = path.join(tempDir, 'executions', runId, 'r2');
      const basePath = path.join(workspaceDir, 'paper.tex');
      const firstPath = path.join(firstDir, 'paper.tex');
      const secondPath = path.join(secondDir, 'paper.tex');
      const document = (body: string) =>
        `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

      yield* Effect.promise(async () => {
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
      });

      const base = createWorkspaceLocation(basePath, 'paper.tex');
      const first = createRunStorageLocation(firstPath, 'r1/paper.tex', runId);
      const second = createRunStorageLocation(
        secondPath,
        'r2/paper.tex',
        runId,
      );
      const output = (
        round: number,
        location: typeof first,
        source = 'paper.tex',
      ): OutputFileInfo => ({
        source,
        location,
        round,
        lineage: { original: base, diffBase: null },
        diff: null,
      });
      const [{ runLatexdiffFromMetadata }, { LaTeXdiffService }] =
        yield* Effect.promise(() =>
          Promise.all([
            import('@latex/latexdiff/diffOperations'),
            import('@latex/latexdiff'),
          ]),
        );
      const result = yield* runLatexdiffFromMetadata({
        rounds: {
          1: [output(1, first)],
          2: [output(2, second, './paper.tex')],
        },
        workspaceRoot: testWorkspaceRoots().workspace,
        generateBetweenRoundDiffs: true,
        latexdiff: {
          channel: 'test',
          service: new LaTeXdiffService('test', testWorkspaceRoots()),
        },
        progress: { report: vi.fn() },
      });

      expect(result.results).toHaveLength(3);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            success: true,
            description: 'paper.tex (r1→r2)',
            diffPath: path.join(firstDir, 'paper_diffr2r1.tex'),
          }),
        ]),
      );
      expect(
        yield* Effect.promise(() =>
          readFile(path.join(firstDir, 'paper_diffr2r1.tex'), 'utf8'),
        ),
      ).toContain('changed');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    'restores flattened BibTeX blocks to the source bibliography directive',
    () =>
      Effect.gen(function* () {
        const { sourceDir, shadowDir } = yield* Effect.promise(() =>
          prepareDiffWorkspace(
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
          ),
        );
        mocks.executeCommand.mockReturnValueOnce(
          Effect.succeed({
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
          }),
        );

        const result = yield* runShadowDiff(sourceDir, shadowDir);

        expect(result).toMatchObject({ success: true });
        const diff = yield* Effect.promise(() =>
          readFile(path.join(shadowDir, 'revised_diff.tex'), 'utf8'),
        );
        expect(diff).toContain('\\bibliography{library}');
        expect(diff).not.toContain('\\begin{thebibliography}');
        expect(diff).not.toContain('\\DIFadd{1}');
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    'sanitizes latexdiff markers from flattened bibliography macro preambles',
    () =>
      Effect.gen(function* () {
        const { DiffFileProcessor } = yield* Effect.promise(
          () => import('@latex/latexdiff/diffFileProcessor'),
        );
        const tempDir = yield* Effect.promise(() =>
          makeTempDir('texra-latexdiff-bbl-preamble-', tempDirs),
        );
        const sourceDir = path.join(tempDir, 'workspace');
        const diffPath = path.join(sourceDir, 'main-diff.tex');
        yield* Effect.promise(async () => {
          await mkdir(sourceDir, { recursive: true });
          await installNodeBackedPlatform(
            sourceDir,
            path.join(tempDir, 'storage'),
          );
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
        });

        yield* new DiffFileProcessor(
          testWorkspaceRoots().config,
        ).processDiffFile(createExternalLocation(diffPath));

        const diff = yield* Effect.promise(() => readFile(diffPath, 'utf8'));
        expect(diff).toContain('\\providecommand \\@ifxundefined [1]{%');
        expect(diff).toContain('\\ifnum #1\\expandafter \\@firstoftwo');
        expect(diff).toContain('\\providecommand \\citenamefont [1]{#1}%');
        expect(diff).toContain(
          '\\providecommand \\bibinfo  [0]{\\@secondoftwo}%',
        );
        expect(diff).toContain('\\DIFadd{added citation text}');
        expect(diff).not.toContain('\\DIFadd{1}');
        expect(diff).not.toContain('DIFAUXCMD');
        expect(diff).not.toContain('\\providecommand \\DIFadd');
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live('mirrors workspace dependencies into diff round storage', () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        makeTempDir('texra-diff-mirror-', tempDirs),
      );
      const workspaceDir = path.join(tempDir, 'workspace');
      const storageRoot = path.join(tempDir, 'storage');
      const dependencyPath = path.join(workspaceDir, 'refs', 'macros.sty');
      yield* Effect.promise(() =>
        mkdir(path.dirname(dependencyPath), { recursive: true }),
      );
      yield* Effect.promise(() =>
        writeFile(dependencyPath, '\\newcommand{\\RR}{\\mathbb{R}}\n'),
      );

      yield* Effect.promise(() =>
        installNodeBackedPlatform(workspaceDir, storageRoot),
      );

      const runId = 'run-1' as RunId;
      const fileService = new RunFileService(runId, testWorkspaceRoots());
      yield* Effect.gen(function* () {
        yield* fileService.mirrorWorkspaceFile(
          createWorkspaceLocation(dependencyPath, 'refs/macros.sty'),
        );
        yield* fileService.ensureMirroredInDiffRoundDir(2);
      }).pipe(Effect.provide(nodePlatformLayer));

      expect(
        yield* Effect.promise(() =>
          readFile(
            path.join(
              runDirUnder(testWorkspaceRoots().storage, runId),
              'diff',
              'r2',
              'refs',
              'macros.sty',
            ),
            'utf8',
          ),
        ),
      ).toBe('\\newcommand{\\RR}{\\mathbb{R}}\n');
    }),
  );
});

describe('LaTeXdiffService logger channel', () => {
  afterEach(() => {
    setLogSink(null);
    vi.restoreAllMocks();
  });

  // #10635: every entry a diff writes carries the channel the service was
  // constructed with, whichever helper below it wrote the line.
  it.effect('binds log lines to the constructor channel', () =>
    Effect.gen(function* () {
      const logs = captureLogEntries();
      const { LaTeXdiffService } = yield* Effect.promise(
        () => import('@latex/latexdiff'),
      );

      const result = yield* new LaTeXdiffService(
        'pinnedLatexdiffChannel',
        testWorkspaceRoots(),
      ).runDiff(
        createExternalLocation('/missing/base.tex'),
        createExternalLocation('/missing/revised.tex'),
        '_diff',
        undefined,
        { cwd: testWorkspaceRoots().workspace },
      );

      expect(result.success).toBe(false);
      expect(
        logs.has(
          'WARN',
          'pinnedLatexdiffChannel',
          'One or both files do not exist',
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(effectDiagnosticsLayer('Trace')),
      Effect.provide(nodePlatformLayer),
    ),
  );
});
