import * as path from 'node:path';
import { Context, Effect } from 'effect';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime';

import type { LaTeXdiffResult } from '@latex/latexdiff';
import type { DiffRunOutcome, DiffRunResult } from '@latex/latexdiff/types';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createModuleMocks } from '@test/support/moduleMocks';

import { createStubDesktopAgentRunHost } from './desktopAgentRunTestHarness.ts';

const mocks = createModuleMocks();

function absolutePath(...segments: string[]): string {
  return path.join(path.sep, ...segments);
}

/** A successful run whose diff landed beside `basePath`, as the service reports it. */
function successResult(
  basePath: string,
  diffFileName = 'main_diff.tex',
): DiffRunResult {
  return {
    success: true,
    diffPath: path.join(path.dirname(basePath), diffFileName),
    message: 'diff written',
    description: basePath,
  };
}

/** A failed run, as the shared core reports it. */
function failureResult(message: string): DiffRunResult {
  return { success: false, message, description: message };
}

function expectOpenedDiff(
  openBuildDisplay: ReturnType<typeof vi.fn>,
  absolutePath: string,
): void {
  expect(openBuildDisplay).toHaveBeenCalledWith({
    kind: 'external',
    absolutePath,
  });
}

const RUN_ID = 'exec-1' as RunId;

async function loadFileActions(options: {
  outcome?: DiffRunOutcome;
  throws?: boolean;
  interrupts?: boolean;
  fallbackResult?: LaTeXdiffResult;
}): Promise<{
  actions: InstanceType<
    typeof import('@desktop/main/desktopProgressFileActions').DesktopProgressFileActions
  >;
  openBuildDisplay: ReturnType<typeof vi.fn>;
  runLatexdiffForRun: ReturnType<typeof vi.fn>;
  runDiff: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  // The desktop adapter delegates the read + dispatch to the shared
  // host-neutral `runLatexdiffForRun`; mock it at that boundary so these
  // tests cover the desktop param-building + outcome-handling, not the core
  // (which `RunLatexdiff.vitest.ts` exercises in isolation).
  const runLatexdiffForRun = vi.fn(() => {
    if (options.interrupts) return Effect.interrupt;
    if (options.throws)
      return Effect.fail(new Error('No workspace path found'));
    return Effect.succeed(options.outcome ?? { results: [] });
  });

  const runDiff = vi.fn((): Effect.Effect<LaTeXdiffResult> =>
    Effect.succeed(
      options.fallbackResult ?? {
        success: true,
        diffPath: absolutePath('workspace', 'main_diff.tex'),
        message: 'diff written',
      },
    ),
  );

  mocks.doMock('@latex/latexdiff/runLatexdiff', () => ({
    runLatexdiffForRun,
  }));
  mocks.doMock('@latex/latexdiff', () => ({
    LaTeXdiffService: class {
      runDiff = runDiff;
    },
  }));
  mocks.doMock('@utils/files/fileLocation', async () => {
    const actual = await vi.importActual<
      typeof import('@utils/files/fileLocation')
    >('@utils/files/fileLocation');
    return {
      ...actual,
      createExternalLocation: (absolutePath: string) => ({
        kind: 'external',
        absolutePath,
      }),
      pathToLocationIn: (_root: string | undefined, absolutePath: string) => ({
        kind: 'external',
        absolutePath,
      }),
    };
  });

  const { DesktopProgressFileActions } =
    await import('@desktop/main/desktopProgressFileActions');

  const openBuildDisplay = vi.fn(() => Effect.void);
  const actions = new DesktopProgressFileActions(
    {
      // The stub's error notice succeeds; this surface's binding refuses the
      // request, as the production one in `desktopHostRequests` does.
      ...createStubDesktopAgentRunHost({ openBuildDisplay }),
      showErrorMessage: (message) =>
        Effect.fail(new Rejected({ reason: message })),
    },
    {
      startRun: vi.fn(),
      listWorkspaceCandidateFiles: vi.fn(() => Effect.succeed([])),
      session: {
        snapshots: { read: vi.fn() },
        roots: { workspace: absolutePath('workspace') },
      } as unknown as SessionHandle,
      globalState: new FakeStateStore(),
      // Every latexdiff program this suite reaches is mocked, so the services
      // the actions take from the window's runtime are never read.
      runtime: {
        contextEffect: Effect.succeed(Context.empty()),
      } as unknown as ProcessRuntime,
    },
  );

  return {
    actions,
    openBuildDisplay,
    runLatexdiffForRun,
    runDiff,
  };
}

/** The window's run: the actions are programs, and the bridge that calls them
 *  settles them on the window's runtime. */
function run<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program);
}

describe('DesktopProgressFileActions latexdiff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the run to the shared core', async () => {
    const outcome: DiffRunOutcome = {
      results: [successResult(absolutePath('run', 'r1', 'main.tex'))],
    };
    const { actions, openBuildDisplay, runLatexdiffForRun, runDiff } =
      await loadFileActions({ outcome });
    await run(
      actions.diffAcceptedFilePair(
        absolutePath('workspace', 'main.tex'),
        absolutePath('run', 'r1', 'main.tex'),
        RUN_ID,
      ),
    );

    expect(runLatexdiffForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        generateBetweenRoundDiffs: true,
      }),
    );
    // No host override: the executor reads `texra.latexdiff.mathMarkup`.
    expect(runLatexdiffForRun.mock.calls[0]?.[0]).not.toHaveProperty(
      'mathMarkup',
    );
    expect(runDiff).not.toHaveBeenCalled();
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('run', 'r1', 'main_diff.tex'),
    );
  });

  it('falls back to single-file latexdiff when the shared core finds no operations', async () => {
    const { actions, openBuildDisplay, runLatexdiffForRun, runDiff } =
      await loadFileActions({
        outcome: { results: [] },
        fallbackResult: {
          success: true,
          diffPath: absolutePath('workspace', 'fallback_diff.tex'),
          message: 'diff written',
        },
      });

    await run(
      actions.diffAcceptedFilePair(
        absolutePath('workspace', 'base.tex'),
        absolutePath('run', 'r1', 'main.tex'),
        RUN_ID,
      ),
    );

    expect(runLatexdiffForRun).toHaveBeenCalledOnce();
    expect(runDiff).toHaveBeenCalledOnce();
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('workspace', 'fallback_diff.tex'),
    );
  });

  it('opens every successful diff, not just the first', async () => {
    const outcome: DiffRunOutcome = {
      results: [
        successResult(absolutePath('run', 'r1', 'main.tex')),
        successResult(absolutePath('run', 'r2', 'main.tex')),
        failureResult('one failed'),
      ],
    };
    const { actions, openBuildDisplay, runDiff } = await loadFileActions({
      outcome,
    });

    await run(
      actions.diffAcceptedFilePair(
        absolutePath('workspace', 'main.tex'),
        absolutePath('run', 'r2', 'main.tex'),
        RUN_ID,
      ),
    );

    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('run', 'r1', 'main_diff.tex'),
    );
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('run', 'r2', 'main_diff.tex'),
    );
    expect(openBuildDisplay).toHaveBeenCalledTimes(2);
    expect(runDiff).not.toHaveBeenCalled();
  });

  it('falls back to single-file latexdiff when the shared core throws', async () => {
    const { actions, openBuildDisplay, runDiff } = await loadFileActions({
      throws: true,
      fallbackResult: {
        success: true,
        diffPath: absolutePath('workspace', 'fallback_diff.tex'),
        message: 'diff written',
      },
    });

    await run(
      actions.diffAcceptedFilePair(
        absolutePath('workspace', 'base.tex'),
        absolutePath('run', 'r1', 'main.tex'),
        RUN_ID,
      ),
    );

    expect(runDiff).toHaveBeenCalledOnce();
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('workspace', 'fallback_diff.tex'),
    );
  });

  it('does not fall back when the shared core is interrupted', async () => {
    const { actions, openBuildDisplay, runDiff } = await loadFileActions({
      interrupts: true,
    });

    await expect(
      run(
        actions.diffAcceptedFilePair(
          absolutePath('workspace', 'base.tex'),
          absolutePath('run', 'r1', 'main.tex'),
          RUN_ID,
        ),
      ),
    ).rejects.toThrow('All fibers interrupted without error');

    expect(runDiff).not.toHaveBeenCalled();
    expect(openBuildDisplay).not.toHaveBeenCalled();
  });
});
