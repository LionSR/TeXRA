import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem, type Path, type Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  openBuildDisplayIfTex,
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@texra/shared/constants/latexTiming';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async (_path: string) => true),
  compileLatex2Pdf: vi.fn(
    (
      _location: unknown,
      _roots: unknown,
      _options: unknown,
    ): Effect.Effect<
      { ok: boolean; logTail: string },
      never,
      WorkspaceFs | StorageFs
    > => Effect.succeed({ ok: true, logTail: '' }),
  ),
  executeCommand: vi.fn(
    async (_command: string, ..._args: unknown[]) => undefined,
  ),
  openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  showTextDocument: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  showLoggedMessage: vi.fn((_channel: string, _message: string) =>
    Effect.succeed(''),
  ),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

/** The roots the host would thread in. Nothing under test reads or writes
 *  through them: the compiler that would is mocked. */
const roots = {
  workspace: '/workspace',
  storage: '/workspace-storage',
  config: {},
} as unknown as WorkspaceRoots;

/**
 * The host entry's provision for the programs under test: the real
 * filesystem service, with the existence probe this suite drives standing
 * in for the disk. A scheduled viewer runs in the test's scope.
 */
const withHostFs = <A, E>(
  program: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner | Scope.Scope
  >,
): Effect.Effect<A, E, Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* program.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        exists: (target: string) => Effect.promise(() => mocks.exists(target)),
      }),
    );
  }).pipe(Effect.provide(nodePlatformLayer));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessage: mocks.showLoggedMessage,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (filePath: string) => ({
      fsPath: filePath,
      path: filePath,
      toString: () => filePath,
    }),
  },
  commands: { executeCommand: mocks.executeCommand },
  window: {
    visibleTextEditors: [],
    showTextDocument: mocks.showTextDocument,
    showErrorMessage: mocks.showErrorMessage,
  },
  workspace: {
    openTextDocument: mocks.openTextDocument,
    getConfiguration: (_section?: string) => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

const workspaceTex = {
  kind: 'workspace' as const,
  absolutePath: '/workspace/paper.tex',
  relativePath: 'paper.tex',
};

describe('openBuildDisplayIfTex viewer delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(true);
    mocks.compileLatex2Pdf.mockReturnValue(
      Effect.succeed({ ok: true, logTail: '' }),
    );
    mocks.executeCommand.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    setLogSink(null);
  });

  it.effect(
    'keeps workspace LaTeX Workshop build failures out of the delivery boolean',
    () =>
      Effect.gen(function* () {
        const logs = captureLogEntries();
        mocks.executeCommand.mockImplementation(async (command: string) => {
          if (command === 'latex-workshop.build') {
            throw new Error('build failed');
          }
          return undefined;
        });

        const delivery = yield* Effect.forkChild(
          withHostFs(openBuildDisplayIfTex(roots, workspaceTex)).pipe(
            Effect.provide(effectDiagnosticsLayer('Trace')),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(LATEX_VIEWER_OPEN_DELAY_MS);

        expect(yield* Fiber.join(delivery)).toBe(true);
        expect(
          logs.has('WARN', 'OpenBuildUtils', 'LaTeX Workshop build failed'),
        ).toBe(true);
      }),
  );

  it.effect(
    'settles the delivery promise when the viewer-open command throws synchronously',
    () =>
      Effect.gen(function* () {
        // A synchronous throw from `executeCommand('latex-workshop.view')` must
        // become a rejection that resolves `false`, not leave the promise pending
        // forever (#10556).
        const logs = captureLogEntries();
        mocks.executeCommand.mockImplementation((command: string) => {
          if (command === 'latex-workshop.view') {
            throw new Error('viewer unavailable');
          }
          return Promise.resolve(undefined);
        });

        const delivery = yield* Effect.forkChild(
          withHostFs(openBuildDisplayIfTex(roots, workspaceTex)).pipe(
            Effect.provide(effectDiagnosticsLayer('Trace')),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(LATEX_VIEWER_OPEN_DELAY_MS);

        expect(yield* Fiber.join(delivery)).toBe(false);
        expect(
          logs.has('WARN', 'OpenBuildUtils', 'Viewer display failed'),
        ).toBe(true);
      }),
  );

  it.effect(
    'keeps viewer delivery true when the refresh command throws synchronously',
    () =>
      Effect.gen(function* () {
        // The refresh command is scheduled only after `latex-workshop.view` has
        // settled, so its synchronous throw must be warn-logged without downgrading
        // the already-established viewer delivery (#10556).
        const logs = captureLogEntries();
        mocks.executeCommand.mockImplementation((command: string) => {
          if (command === 'latex-workshop.refresh-viewer') {
            throw new Error('refresh unavailable');
          }
          return Promise.resolve(undefined);
        });

        const delivery = yield* Effect.forkChild(
          withHostFs(openBuildDisplayIfTex(roots, workspaceTex)).pipe(
            Effect.provide(effectDiagnosticsLayer('Trace')),
          ),
          { startImmediately: true },
        );
        yield* TestClock.adjust(LATEX_VIEWER_OPEN_DELAY_MS);
        yield* TestClock.adjust(LATEX_VIEWER_REFRESH_DELAY_MS);

        expect(yield* Fiber.join(delivery)).toBe(true);
        expect(
          logs.has('WARN', 'OpenBuildUtils', 'Viewer refresh failed'),
        ).toBe(true);
      }),
  );

  it.effect(
    'propagates pre-view failures before the detached viewer wait',
    () =>
      Effect.gen(function* () {
        // The detached path must still await and propagate file-open/build errors
        // so the latexdiff command's existing error handler stays authoritative.
        mocks.openTextDocument.mockRejectedValueOnce(new Error('open failed'));

        const error = yield* Effect.flip(
          withHostFs(prepareBuildDisplay(roots, workspaceTex)),
        );
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('open failed');
        expect(mocks.executeCommand).not.toHaveBeenCalledWith(
          'latex-workshop.view',
        );
      }),
  );

  it.effect('reports external compile failure as not viewer-ready', () =>
    Effect.gen(function* () {
      // The compiler reads the session's rooted views, which the real
      // `withSessionFs` serves from the roots the host threads in.
      const compiledOver: (string | undefined)[] = [];
      mocks.compileLatex2Pdf.mockReturnValue(
        Effect.gen(function* () {
          compiledOver.push((yield* WorkspaceFs).root, (yield* StorageFs).root);
          return { ok: false, logTail: 'compilation failed' };
        }),
      );
      const externalTex = {
        kind: 'external' as const,
        absolutePath: '/tmp/paper.tex',
      };

      const ready = yield* withHostFs(
        prepareBuildDisplay(roots, externalTex, { scheduleViewer: false }),
      );
      expect(ready).toBe(false);
      expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(externalTex, roots, {
        outputDirectory: '/tmp/build',
      });
      expect(compiledOver).toStrictEqual(['/workspace', '/workspace-storage']);
      yield* TestClock.adjust(LATEX_VIEWER_OPEN_DELAY_MS);
      expect(mocks.executeCommand).not.toHaveBeenCalledWith(
        'latex-workshop.view',
      );
    }),
  );

  it.effect(
    'keeps final-result viewer delivery deterministic across sequential latexdiff results',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        mocks.openTextDocument.mockImplementation(async (uri: unknown) => {
          const fsPath = (uri as { fsPath: string }).fsPath;
          order.push(`open:${fsPath}`);
          return { uri };
        });
        mocks.showTextDocument.mockImplementation(async () => {
          order.push('show');
        });
        mocks.executeCommand.mockImplementation(async (command: string) => {
          order.push(command);
          return undefined;
        });

        const diffs = [
          { ...workspaceTex, absolutePath: '/workspace/diff-1.tex' },
          { ...workspaceTex, absolutePath: '/workspace/diff-2.tex' },
        ];

        // Prepare every diff without scheduling a viewer handoff, as the
        // multi-result latexdiff loop does (#10553).
        for (const diff of diffs) {
          yield* withHostFs(
            prepareBuildDisplay(roots, diff, {
              preserveFocus: true,
              scheduleViewer: false,
            }),
          );
        }

        // The file-open/show/build phase is serialized in result order and no
        // stale intermediate viewer timer has been scheduled.
        expect(order).toEqual([
          'open:/workspace/diff-1.tex',
          'show',
          'latex-workshop.build',
          'open:/workspace/diff-2.tex',
          'show',
          'latex-workshop.build',
        ]);
        expect(order).not.toContain('latex-workshop.view');

        // Schedule exactly one viewer for the final diff context and let it fire.
        yield* Effect.forkChild(withHostFs(scheduleViewerDisplay), {
          startImmediately: true,
        });
        yield* TestClock.adjust(LATEX_VIEWER_OPEN_DELAY_MS);

        const viewerIndexes = order
          .map((entry, index) => (entry === 'latex-workshop.view' ? index : -1))
          .filter((index) => index >= 0);
        expect(viewerIndexes).toHaveLength(1);
        expect(viewerIndexes[0]).toBeGreaterThan(
          order.lastIndexOf('latex-workshop.build'),
        );
      }),
  );
});
