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
  metadataOutcome?: DiffOutcome;
  scanOutcome?: DiffOutcome;
  fallbackResult?: {
    success: boolean;
    message?: string;
    diffFileName?: string;
  };
}): Promise<{
  actions: FileActionsInstance;
  openPath: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  runLatexdiffFromMetadata: ReturnType<typeof vi.fn>;
  runLatexdiffViaWorkspaceScan: ReturnType<typeof vi.fn>;
  runDiff: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();

  const runLatexdiffFromMetadata = vi.fn(
    async () => mocks.metadataOutcome ?? { results: [], totalOperations: 0 },
  );
  const runLatexdiffViaWorkspaceScan = vi.fn(
    async () => mocks.scanOutcome ?? { results: [], totalOperations: 0 },
  );
  const runDiff = vi.fn(
    async () =>
      mocks.fallbackResult ?? {
        success: true,
        diffFileName: 'main_diff.tex',
      },
  );

  vi.doMock('@latex/latexdiff/diffOperations', () => ({
    runLatexdiffFromMetadata,
    runLatexdiffViaWorkspaceScan,
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
      TaskRunFileService: class {
        constructor(readonly executionId?: string) {}
      },
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
    runLatexdiffFromMetadata,
    runLatexdiffViaWorkspaceScan,
    runDiff,
  };
}

describe('DesktopProgressFileActions latexdiff', () => {
  afterEach(() => {
    vi.doUnmock('@latex/latexdiff');
    vi.doUnmock('@latex/latexdiff/diffOperations');
    vi.doUnmock('@utils/files');
    vi.restoreAllMocks();
  });

  it('uses metadata-driven round diffs before single-file latexdiff', async () => {
    const metadataOutcome = {
      results: [
        {
          success: true,
          basePath: '/run/r1/main.tex',
          diffFileName: 'main_diff.tex',
        },
      ],
      totalOperations: 1,
    };
    const { actions, openPath, runLatexdiffFromMetadata, runDiff } =
      await loadFileActions({ metadataOutcome });
    const outputsByRound = new Map([[1, [outputInfo('/run/r1/main.tex')]]]);

    await actions.runLatexdiffForRun(
      '/workspace/main.tex',
      '/run/r1/main.tex',
      {
        outputsByRound,
        executionId: 'exec-1',
      },
    );

    expect(runLatexdiffFromMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        rounds: outputsByRound,
        mathMarkup: 'coarse',
        generateBetweenRoundDiffs: true,
      }),
    );
    expect(runDiff).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith('/run/r1/main_diff.tex');
  });

  it('uses workspace scan when no output metadata is available', async () => {
    const scanOutcome = {
      results: [
        {
          success: true,
          basePath: '/workspace/main.tex',
          diffFileName: 'main_diff.tex',
        },
      ],
      totalOperations: 1,
    };
    const {
      actions,
      openPath,
      runLatexdiffFromMetadata,
      runLatexdiffViaWorkspaceScan,
      runDiff,
    } = await loadFileActions({ scanOutcome });

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

    expect(runLatexdiffFromMetadata).not.toHaveBeenCalled();
    expect(runLatexdiffViaWorkspaceScan).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'orchestrator',
        model: 'gpt-5',
        inputFile: 'main.tex',
        mathMarkup: 'coarse',
        generateBetweenRoundDiffs: true,
      }),
    );
    expect(runDiff).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith('/workspace/main_diff.tex');
  });

  it('falls back to single-file latexdiff when shared discovery finds no rounds', async () => {
    const { actions, openPath, runLatexdiffFromMetadata, runDiff } =
      await loadFileActions({
        metadataOutcome: { results: [], totalOperations: 0 },
        fallbackResult: { success: true, diffFileName: 'fallback_diff.tex' },
      });

    await actions.runLatexdiffForRun(
      '/workspace/base.tex',
      '/run/r1/main.tex',
      {
        outputsByRound: new Map([[1, [outputInfo('/run/r1/main.tex')]]]),
      },
    );

    expect(runLatexdiffFromMetadata).toHaveBeenCalledOnce();
    expect(runDiff).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledWith('/workspace/fallback_diff.tex');
  });
});
