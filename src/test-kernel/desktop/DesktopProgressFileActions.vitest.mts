import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutputFileInfo } from '@shared/schemas';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

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
  outputsByRound: Map<number, OutputFileInfo[]>;
  executionId?: string;
  workspaceScan?: {
    agent: string;
    model: string;
    inputFile: string;
  };
};

type FileActionsInstance = {
  runLatexdiffForRun(
    baseFile: string,
    editedFile: string,
    context: RunContext,
  ): Promise<void>;
};

type FileActionsModule = {
  DesktopProgressFileActions: new (
    options: unknown,
    host: unknown,
  ) => FileActionsInstance;
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

async function loadFileActions(mocks: {
  outcome?: DiffOutcome;
  fallbackResult?: {
    success: boolean;
    message?: string;
    diffFileName?: string;
  };
}): Promise<{
  actions: FileActionsInstance;
  openPath: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  runLatexdiffForExecution: ReturnType<typeof vi.fn>;
  runDiff: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  // The desktop adapter delegates the resolve + dispatch policy to the shared
  // host-neutral `runLatexdiffForExecution`; mock it at that boundary so these
  // tests cover the desktop param-building + outcome-handling, not the core
  // (which `RunLatexdiff.vitest.mts` exercises in isolation).
  const runLatexdiffForExecution = vi.fn(async () => ({
    outcome: mocks.outcome ?? { results: [], totalOperations: 0 },
    source: 'metadata' as const,
  }));
  const runDiff = vi.fn(
    async () =>
      mocks.fallbackResult ?? {
        success: true,
        diffFileName: 'main_diff.tex',
      },
  );

  vi.doMock('@latex/latexdiff/runLatexdiff', () => ({
    runLatexdiffForExecution,
  }));
  vi.doMock('@latex/latexdiff', () => ({
    LaTeXdiffService: class {
      runDiff = runDiff;
    },
  }));
  vi.doMock('@utils/files', async () => {
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

  const module = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopProgressFileActions.ts'))
  )) as FileActionsModule;

  const openPath = vi.fn();
  const showErrorMessage = vi.fn();
  const actions = new module.DesktopProgressFileActions(
    {
      openPath,
      showErrorMessage,
    },
    {
      runtimeHost: { emit: vi.fn() },
      runExecution: vi.fn(),
      listWorkspaceCandidateFiles: vi.fn(async () => []),
    },
  );

  return {
    actions,
    openPath,
    showErrorMessage,
    runLatexdiffForExecution,
    runDiff,
  };
}

describe('DesktopProgressFileActions latexdiff', () => {
  afterEach(() => {
    vi.doUnmock('@latex/latexdiff');
    vi.doUnmock('@latex/latexdiff/runLatexdiff');
    vi.doUnmock('@utils/files');
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
    const { actions, openPath, runLatexdiffForExecution, runDiff } =
      await loadFileActions({ outcome });
    const outputsByRound = new Map([[1, [outputInfo('/run/r1/main.tex')]]]);

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
    expect(openPath).toHaveBeenCalledWith('/run/r1/main_diff.tex');
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
    const { actions, openPath, runLatexdiffForExecution, runDiff } =
      await loadFileActions({ outcome });

    await actions.runLatexdiffForRun(
      '/workspace/main.tex',
      '/workspace/main_orchestrator_r1_gpt.tex',
      {
        outputsByRound: new Map(),
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
    expect(openPath).toHaveBeenCalledWith('/workspace/main_diff.tex');
  });

  it('falls back to single-file latexdiff when the shared core finds no operations', async () => {
    const { actions, openPath, runLatexdiffForExecution, runDiff } =
      await loadFileActions({
        outcome: { results: [], totalOperations: 0 },
        fallbackResult: { success: true, diffFileName: 'fallback_diff.tex' },
      });

    await actions.runLatexdiffForRun(
      '/workspace/base.tex',
      '/run/r1/main.tex',
      {
        outputsByRound: new Map([[1, [outputInfo('/run/r1/main.tex')]]]),
      },
    );

    expect(runLatexdiffForExecution).toHaveBeenCalledOnce();
    expect(runDiff).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledWith('/workspace/fallback_diff.tex');
  });
});
