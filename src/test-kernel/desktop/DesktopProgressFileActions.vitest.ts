import * as path from 'node:path';
import { Effect } from 'effect';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime';

import type { LaTeXdiffResult } from '@latex/latexdiff';
import type { DiffRunOutcome, DiffRunResult } from '@latex/latexdiff/types';
import type { OutputFileInfo } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createModuleMocks } from '@test/support/moduleMocks';

import { createStubDesktopAgentRunHost } from './desktopAgentRunTestHarness.ts';
import { loadSourceModule } from './loadSourceModule.ts';

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

function outputInfo(filePath: string): OutputFileInfo {
  return {
    source: 'main.tex',
    location: { kind: 'external', absolutePath: filePath },
    round: 1,
    lineage: {
      original: {
        kind: 'external',
        absolutePath: absolutePath('workspace', 'main.tex'),
      },
      diffBase: null,
    },
    diff: null,
  };
}

async function loadFileActions(options: {
  outcome?: DiffRunOutcome;
  throws?: boolean;
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

  // The desktop adapter delegates the resolve + dispatch policy to the shared
  // host-neutral `runLatexdiffForRun`; mock it at that boundary so these
  // tests cover the desktop param-building + outcome-handling, not the core
  // (which `RunLatexdiff.vitest.ts` exercises in isolation).
  const runLatexdiffForRun = vi.fn(() =>
    options.throws
      ? Effect.fail(new Error('No workspace path found'))
      : Effect.succeed({
          outcome: options.outcome ?? { results: [] },
          source: 'metadata' as const,
        }),
  );

  const runDiff = vi.fn((): Effect.Effect<LaTeXdiffResult> =>
    Effect.succeed(
      options.fallbackResult ?? {
        success: true,
        diffPath: absolutePath('workspace', 'main_diff.tex'),
        message: 'diff written',
      },
    ),
  );

  mocks.doMock('@platform/platform', () => ({
    platform: () => ({ fs: { readDirectory: vi.fn(), isSymlink: vi.fn() } }),
  }));
  mocks.doMock('@platform/processRuntime', () => ({
    effectRuntime: () => ({ runPromise: Effect.runPromise }),
  }));
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
      pathToLocation: (absolutePath: string) => ({
        kind: 'external',
        absolutePath,
      }),
    };
  });

  const { DesktopProgressFileActions } = await loadSourceModule(
    '@desktop/main/desktopProgressFileActions',
  );

  const openBuildDisplay = vi.fn();
  const actions = new DesktopProgressFileActions(
    createStubDesktopAgentRunHost({ openBuildDisplay }),
    {
      startRun: vi.fn(),
      listWorkspaceCandidateFiles: vi.fn(async () => []),
      session: { snapshots: { read: vi.fn() } } as unknown as SessionHandle,
      globalState: new FakeStateStore(),
    },
  );

  return {
    actions,
    openBuildDisplay,
    runLatexdiffForRun,
    runDiff,
  };
}

describe('DesktopProgressFileActions latexdiff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes pre-resolved round outputs to the shared core', async () => {
    const outcome: DiffRunOutcome = {
      results: [successResult(absolutePath('run', 'r1', 'main.tex'))],
    };
    const { actions, openBuildDisplay, runLatexdiffForRun, runDiff } =
      await loadFileActions({ outcome });
    const outputsByRound = {
      1: [outputInfo(absolutePath('run', 'r1', 'main.tex'))],
    };

    await actions.diffAcceptedFilePair(
      absolutePath('workspace', 'main.tex'),
      absolutePath('run', 'r1', 'main.tex'),
      {
        outputsByRound,
        runId: 'exec-1',
      },
    );

    expect(runLatexdiffForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outputsByRound,
        runId: 'exec-1',
        mathMarkup: 'coarse',
        generateBetweenRoundDiffs: true,
      }),
    );
    expect(runDiff).not.toHaveBeenCalled();
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('run', 'r1', 'main_diff.tex'),
    );
  });

  it('passes the scan identity (and no rounds) when only a workspace scan is available', async () => {
    const outcome: DiffRunOutcome = {
      results: [successResult(absolutePath('workspace', 'main.tex'))],
    };
    const { actions, openBuildDisplay, runLatexdiffForRun, runDiff } =
      await loadFileActions({ outcome });

    await actions.diffAcceptedFilePair(
      absolutePath('workspace', 'main.tex'),
      absolutePath('workspace', 'main_orchestrator_r1_gpt.tex'),
      {
        outputsByRound: {},
        workspaceScan: {
          agent: 'orchestrator',
          model: 'gpt-5',
          inputFile: 'main.tex',
        },
      },
    );

    expect(runLatexdiffForRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'orchestrator',
        model: 'gpt-5',
        inputFile: 'main.tex',
        outputsByRound: null,
        mathMarkup: 'coarse',
        generateBetweenRoundDiffs: true,
      }),
    );
    expect(runDiff).not.toHaveBeenCalled();
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('workspace', 'main_diff.tex'),
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

    await actions.diffAcceptedFilePair(
      absolutePath('workspace', 'base.tex'),
      absolutePath('run', 'r1', 'main.tex'),
      {
        outputsByRound: {
          1: [outputInfo(absolutePath('run', 'r1', 'main.tex'))],
        },
      },
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

    await actions.diffAcceptedFilePair(
      absolutePath('workspace', 'main.tex'),
      absolutePath('run', 'r2', 'main.tex'),
      {
        outputsByRound: {
          1: [outputInfo(absolutePath('run', 'r1', 'main.tex'))],
        },
      },
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

    await actions.diffAcceptedFilePair(
      absolutePath('workspace', 'base.tex'),
      absolutePath('run', 'r1', 'main.tex'),
      {
        outputsByRound: {},
        workspaceScan: { agent: 'a', model: 'm', inputFile: 'main.tex' },
      },
    );

    expect(runDiff).toHaveBeenCalledOnce();
    expectOpenedDiff(
      openBuildDisplay,
      absolutePath('workspace', 'fallback_diff.tex'),
    );
  });
});
