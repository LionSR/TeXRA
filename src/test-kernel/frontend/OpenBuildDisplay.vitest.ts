import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem, type Path } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime';
import {
  openBuildDisplayIfTex,
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@shared/constants/latexTiming';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { captureLogEntries } from '@test/support/logSinkCapture';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async (_path: string) => true),
  isLatexFile: vi.fn((_path: string) => true),
  compileLatex2Pdf: vi.fn((): Effect.Effect<{ ok: boolean; logTail: string }> =>
    Effect.succeed({ ok: true, logTail: '' }),
  ),
  pathToLocationIn: vi.fn(
    (_root: string | undefined, absolutePath: string) => ({
      kind: 'workspace' as const,
      absolutePath,
      relativePath: 'paper.tex',
    }),
  ),
  executeCommand: vi.fn(
    async (_command: string, ..._args: unknown[]) => undefined,
  ),
  openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  showTextDocument: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  showLoggedMessage: vi.fn((_channel: string, _message: string) =>
    Effect.succeed(''),
  ),
}));

vi.mock('@common/files/fileTypeUtils', () => ({
  isLatexFile: mocks.isLatexFile,
}));

vi.mock('@utils/files/fileLocation', () => ({
  pathToLocationIn: mocks.pathToLocationIn,
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@platform/rootedFs', () => ({
  withSessionFs: (_roots: unknown, program: unknown) => program,
}));

/** The session the host would thread in; only its roots reach the compile. */
const session = { roots: { config: {} } } as unknown as SessionHandle;

/**
 * The host entry's provision for the programs under test: the real
 * filesystem service, with the existence probe this suite drives standing
 * in for the disk.
 */
const withHostFs = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, E> =>
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

vi.mock('@logger/logUtils', () => ({
  createLog: (channel: string) => ({
    debug: vi.fn(),
    info: (message: string) => mocks.info(channel, message),
    warn: (message: string) => mocks.warn(channel, message),
    error: (message: string) => mocks.error(channel, message),
  }),
  warn: mocks.warn,
  error: mocks.error,
  info: mocks.info,
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
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(true);
    mocks.isLatexFile.mockReturnValue(true);
    mocks.compileLatex2Pdf.mockReturnValue(
      Effect.succeed({ ok: true, logTail: '' }),
    );
    mocks.executeCommand.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    setLogSink(null);
    vi.useRealTimers();
  });

  it.live('reports non-delivery when the PDF viewer open rejects', () =>
    Effect.gen(function* () {
      const logs = captureLogEntries();
      mocks.executeCommand.mockImplementation(async (command: string) => {
        if (command === 'latex-workshop.view') {
          throw new Error('viewer unavailable');
        }
        return undefined;
      });

      const delivery = yield* Effect.forkChild(
        withHostFs(openBuildDisplayIfTex(session, workspaceTex)).pipe(
          Effect.provide(effectDiagnosticsLayer),
        ),
        { startImmediately: true },
      );
      // Flush the setup chain (exists -> openTextDocument -> showTextDocument ->
      // latex-workshop.build) before advancing the clock so the viewer-open timer
      // is actually registered when the 5s advance runs (#10555).
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      yield* Effect.promise(() =>
        vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
      );

      expect(yield* Fiber.join(delivery)).toBe(false);
      expect(logs.has('WARN', 'OpenBuildUtils', 'Viewer display failed')).toBe(
        true,
      );
    }),
  );

  it.live(
    'reports delivery only once the viewer-open command has settled',
    () =>
      Effect.gen(function* () {
        let settled = false;
        const delivery = yield* Effect.forkChild(
          withHostFs(openBuildDisplayIfTex(session, workspaceTex)),
          { startImmediately: true },
        );
        delivery.addObserver(() => {
          settled = true;
        });

        // Flush the setup chain first so the `settled` boundary is measured against
        // the viewer-open timer rather than against the pending setup microtasks.
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS - 1),
        );
        expect(settled).toBe(false);

        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
        expect(yield* Fiber.join(delivery)).toBe(true);
        expect(mocks.executeCommand).toHaveBeenCalledWith(
          'latex-workshop.view',
        );
      }),
  );

  it.live(
    'keeps workspace LaTeX Workshop build failures out of the delivery boolean',
    () =>
      Effect.gen(function* () {
        mocks.executeCommand.mockImplementation(async (command: string) => {
          if (command === 'latex-workshop.build') {
            throw new Error('build failed');
          }
          return undefined;
        });

        const delivery = yield* Effect.forkChild(
          withHostFs(openBuildDisplayIfTex(session, workspaceTex)),
          { startImmediately: true },
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
        );

        expect(yield* Fiber.join(delivery)).toBe(true);
        expect(mocks.warn).toHaveBeenCalledWith(
          'OpenBuildUtils',
          expect.stringContaining('LaTeX Workshop build failed'),
        );
      }),
  );

  it.live(
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
          withHostFs(openBuildDisplayIfTex(session, workspaceTex)).pipe(
            Effect.provide(effectDiagnosticsLayer),
          ),
          { startImmediately: true },
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
        );

        expect(yield* Fiber.join(delivery)).toBe(false);
        expect(
          logs.has('WARN', 'OpenBuildUtils', 'Viewer display failed'),
        ).toBe(true);
      }),
  );

  it.live(
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
          withHostFs(openBuildDisplayIfTex(session, workspaceTex)).pipe(
            Effect.provide(effectDiagnosticsLayer),
          ),
          { startImmediately: true },
        );
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
        );
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_REFRESH_DELAY_MS),
        );

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
          withHostFs(prepareBuildDisplay(session, workspaceTex)),
        );
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('open failed');
        expect(mocks.executeCommand).not.toHaveBeenCalledWith(
          'latex-workshop.view',
        );
      }),
  );

  it.live('reports external compile failure as not viewer-ready', () =>
    Effect.gen(function* () {
      mocks.compileLatex2Pdf.mockReturnValue(
        Effect.succeed({ ok: false, logTail: 'compilation failed' }),
      );
      const externalTex = {
        kind: 'external' as const,
        absolutePath: '/tmp/paper.tex',
      };

      const ready = yield* withHostFs(
        prepareBuildDisplay(session, externalTex, { scheduleViewer: false }),
      );
      expect(ready).toBe(false);
      yield* Effect.promise(() =>
        vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
      );
      expect(mocks.executeCommand).not.toHaveBeenCalledWith(
        'latex-workshop.view',
      );
    }),
  );

  it.live(
    'keeps the final viewer schedulable when a later prepare rejects',
    () =>
      Effect.gen(function* () {
        const order: string[] = [];
        mocks.openTextDocument.mockImplementation(async (uri: unknown) => {
          const fsPath = (uri as { fsPath: string }).fsPath;
          order.push(`open:${fsPath}`);
          if (fsPath === '/workspace/diff-2.tex') {
            throw new Error('second setup failed');
          }
          return { uri };
        });
        mocks.showTextDocument.mockImplementation(async () => {
          order.push('show');
        });
        mocks.executeCommand.mockImplementation(async (command: string) => {
          order.push(command);
          return undefined;
        });

        const first = {
          ...workspaceTex,
          absolutePath: '/workspace/diff-1.tex',
        };
        const second = {
          ...workspaceTex,
          absolutePath: '/workspace/diff-2.tex',
        };

        yield* withHostFs(
          prepareBuildDisplay(session, first, { scheduleViewer: false }),
        );
        const error = yield* Effect.flip(
          withHostFs(
            prepareBuildDisplay(session, second, { scheduleViewer: false }),
          ),
        );
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('second setup failed');

        // The command's try/finally schedules the final viewer for the last
        // prepared diff after the setup rejection propagates.
        yield* Effect.forkChild(withHostFs(scheduleViewerDisplay), {
          startImmediately: true,
        });
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
        );

        const viewerIndexes = order
          .map((entry, index) => (entry === 'latex-workshop.view' ? index : -1))
          .filter((index) => index >= 0);
        expect(viewerIndexes).toHaveLength(1);
      }),
  );

  it.live(
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
            prepareBuildDisplay(session, diff, {
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
        yield* Effect.promise(() =>
          vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS),
        );

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
