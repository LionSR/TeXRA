import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutputFileInfo, RoundIndexed } from '@shared/schemas';
import { createModuleMocks } from '@test/support/moduleMocks';

import { createStubDesktopAgentExecutionHost } from './desktopAgentExecutionTestHarness.ts';
import { loadSourceModule } from './loadSourceModule.ts';

const mocks = createModuleMocks();

type DiffOutcome = {
  results: Array<{
    success: boolean;
    message?: string;
    basePath?: string;
    diffFileName?: string;
  }>;
  totalOperations: number;
};

type RunContext = {
  outputsByRound: RoundIndexed<OutputFileInfo>;
  executionId?: string;
  workspaceScan?: {
    agent: string;
    model: string;
    inputFile: string;
    outputFiles?: string[];
  };
};

function outputInfo(filePath: string): OutputFileInfo {
  return {
    source: 'main.tex',
    location: { kind: 'external', absolutePath: filePath },
    round: 1,
    lineage: {
      original: { kind: 'external', absolutePath: '/workspace/main.tex' },
      diffBase: null,
      diffFile: null,
    },
    diff: null,
  };
}

async function loadFileActions(options: {
  outcome?: DiffOutcome;
  throws?: boolean;
  fallbackResult?: {
    success: boolean;
    message?: string;
    diffFileName?: string;
  };
}): Promise<{
  actions: InstanceType<
    typeof import('@desktop/main/desktopProgressFileActions').DesktopProgressFileActions
  >;
  openBuildDisplay: ReturnType<typeof vi.fn>;
  runLatexdiffForExecution: ReturnType<typeof vi.fn>;
  runDiff: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  // The desktop adapter delegates the resolve + dispatch policy to the shared
  // host-neutral `runLatexdiffForExecution`; mock it at that boundary so these
  // tests cover the desktop param-building + outcome-handling, not the core
  // (which `RunLatexdiff.vitest.ts` exercises in isolation).
  const runLatexdiffForExecution = vi.fn(async () => {
    if (options.throws) throw new Error('No workspace path found');
    return {
      outcome: options.outcome ?? { results: [], totalOperations: 0 },
      source: 'metadata' as const,
    };
  });
  const runDiff = vi.fn(
    async () =>
      options.fallbackResult ?? {
        success: true,
        diffFileName: 'main_diff.tex',
      },
  );

  mocks.doMock('@latex/latexdiff/runLatexdiff', () => ({
    runLatexdiffForExecution,
  }));
  mocks.doMock('@latex/latexdiff', () => ({
    LaTeXdiffService: class {
      runDiff = runDiff;
    },
  }));
  mocks.doMock('@utils/files', async () => {
    const actual =
      await vi.importActual<typeof import('@utils/files')>('@utils/files');
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
    createStubDesktopAgentExecutionHost({ openBuildDisplay }),
    {
      startExecution: vi.fn(),
      listWorkspaceCandidateFiles: vi.fn(async () => []),
    },
  );

  return {
    actions,
    openBuildDisplay,
    runLatexdiffForExecution,
    runDiff,
  };
}

describe('DesktopProgressFileActions latexdiff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes pre-resolved round outputs to the shared core', async () => {
    const outcome = {
      results: [
        {
          success: true,
          basePath: '/run/r1/main.tex',
          diffFileName: 'main_diff.tex',
        },
      ],
      totalOperations: 1,
    };
    const { actions, openBuildDisplay, runLatexdiffForExecution, runDiff } =
      await loadFileActions({ outcome });
    const outputsByRound = { 1: [outputInfo('/run/r1/main.tex')] };

    await actions.runLatexdiffForRun(
      '/workspace/main.tex',
      '/run/r1/main.tex',
      {
        outputsByRound,
        executionId: 'exec-1',
      },
    );

    expect(runLatexdiffForExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        outputsByRound,
        runId: 'exec-1',
        mathMarkup: 'coarse',
        generateBetweenRoundDiffs: true,
      }),
    );
    expect(runDiff).not.toHaveBeenCalled();
    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/run/r1/main_diff.tex',
    });
  });

  it('passes the scan identity (and no rounds) when only a workspace scan is available', async () => {
    const outcome = {
      results: [
        {
          success: true,
          basePath: '/workspace/main.tex',
          diffFileName: 'main_diff.tex',
        },
      ],
      totalOperations: 1,
    };
    const { actions, openBuildDisplay, runLatexdiffForExecution, runDiff } =
      await loadFileActions({ outcome });

    await actions.runLatexdiffForRun(
      '/workspace/main.tex',
      '/workspace/main_orchestrator_r1_gpt.tex',
      {
        outputsByRound: {},
        workspaceScan: {
          agent: 'orchestrator',
          model: 'gpt-5',
          inputFile: 'main.tex',
        },
      },
    );

    expect(runLatexdiffForExecution).toHaveBeenCalledWith(
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
    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/workspace/main_diff.tex',
    });
  });

  it('falls back to single-file latexdiff when the shared core finds no operations', async () => {
    const { actions, openBuildDisplay, runLatexdiffForExecution, runDiff } =
      await loadFileActions({
        outcome: { results: [], totalOperations: 0 },
        fallbackResult: { success: true, diffFileName: 'fallback_diff.tex' },
      });

    await actions.runLatexdiffForRun(
      '/workspace/base.tex',
      '/run/r1/main.tex',
      {
        outputsByRound: { 1: [outputInfo('/run/r1/main.tex')] },
      },
    );

    expect(runLatexdiffForExecution).toHaveBeenCalledOnce();
    expect(runDiff).toHaveBeenCalledOnce();
    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/workspace/fallback_diff.tex',
    });
  });

  it('opens every successful diff, not just the first', async () => {
    const outcome = {
      results: [
        {
          success: true,
          basePath: '/run/r1/main.tex',
          diffFileName: 'main_diff.tex',
        },
        {
          success: true,
          basePath: '/run/r2/main.tex',
          diffFileName: 'main_diff.tex',
        },
        { success: false, message: 'one failed' },
      ],
      totalOperations: 3,
    };
    const { actions, openBuildDisplay, runDiff } = await loadFileActions({
      outcome,
    });

    await actions.runLatexdiffForRun(
      '/workspace/main.tex',
      '/run/r2/main.tex',
      {
        outputsByRound: { 1: [outputInfo('/run/r1/main.tex')] },
      },
    );

    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/run/r1/main_diff.tex',
    });
    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/run/r2/main_diff.tex',
    });
    expect(openBuildDisplay).toHaveBeenCalledTimes(2);
    expect(runDiff).not.toHaveBeenCalled();
  });

  it('falls back to single-file latexdiff when the shared core throws', async () => {
    const { actions, openBuildDisplay, runDiff } = await loadFileActions({
      throws: true,
      fallbackResult: { success: true, diffFileName: 'fallback_diff.tex' },
    });

    await actions.runLatexdiffForRun(
      '/workspace/base.tex',
      '/run/r1/main.tex',
      {
        outputsByRound: {},
        workspaceScan: { agent: 'a', model: 'm', inputFile: 'main.tex' },
      },
    );

    expect(runDiff).toHaveBeenCalledOnce();
    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/workspace/fallback_diff.tex',
    });
  });

  it('falls back to single-file latexdiff when every shared operation failed', async () => {
    const { actions, openBuildDisplay, runDiff } = await loadFileActions({
      outcome: {
        results: [{ success: false, message: 'missing base' }],
        totalOperations: 1,
      },
      fallbackResult: { success: true, diffFileName: 'fallback_diff.tex' },
    });

    await actions.runLatexdiffForRun(
      '/workspace/base.tex',
      '/run/r1/main.tex',
      {
        outputsByRound: { 1: [outputInfo('/run/r1/main.tex')] },
      },
    );

    expect(runDiff).toHaveBeenCalledOnce();
    expect(openBuildDisplay).toHaveBeenCalledWith({
      kind: 'external',
      absolutePath: '/workspace/fallback_diff.tex',
    });
  });

  it('threads the run output files into the shared core for scan resolution', async () => {
    const { actions, runLatexdiffForExecution } = await loadFileActions({
      outcome: {
        results: [
          {
            success: true,
            basePath: '/workspace/a.tex',
            diffFileName: 'a_diff.tex',
          },
        ],
        totalOperations: 1,
      },
    });

    await actions.runLatexdiffForRun(
      '/workspace/a.tex',
      '/workspace/a_r1.tex',
      {
        outputsByRound: {},
        workspaceScan: {
          agent: 'orchestrator',
          model: 'gpt-5',
          inputFile: 'a.tex',
          outputFiles: ['a.tex', 'b.tex'],
        },
      },
    );

    expect(runLatexdiffForExecution).toHaveBeenCalledWith(
      expect.objectContaining({ outputFiles: ['a.tex', 'b.tex'] }),
    );
  });
});
