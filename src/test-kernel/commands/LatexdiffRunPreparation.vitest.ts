import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  prepareBuildDisplay: vi.fn(),
  scheduleViewerDisplay: vi.fn(),
  showLoggedMessage: vi.fn(),
  showLoggedErrorMessage: vi.fn(),
  showLoggedInfoMessage: vi.fn(),
  showLoggedMessageWithDocs: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  checkToolInstalled: vi.fn(),
  pathToLocation: vi.fn((absolutePath: string) => {
    if (absolutePath.startsWith('/tmp/')) {
      return { kind: 'external' as const, absolutePath };
    }
    return {
      kind: 'workspace' as const,
      absolutePath,
      relativePath: 'paper.tex',
    };
  }),
  openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  showTextDocument: vi.fn(async () => undefined),
  showQuickPick: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn(),
  registerCommandEntries: vi.fn(),
  workspaceSMGet: vi.fn(),
  normalizeRunLatexdiffOutputsByRound: vi.fn(),
  runLatexdiffForExecution: vi.fn(),
  runLatexdiffHandler: undefined as
    ((config: unknown) => Promise<void>) | undefined,
}));

vi.mock('@agent/storage', () => ({
  createLatexExecutionDiscovery: vi.fn(),
}));

vi.mock('@commands/_shared/registerCommands', () => ({
  registerCommandEntries: (
    _context: unknown,
    entries: Array<{ id: string; handler: (config: unknown) => Promise<void> }>,
  ) => {
    mocks.registerCommandEntries(_context, entries);
    mocks.runLatexdiffHandler = entries.find(
      ({ id }) => id === 'texra.runLatexdiff',
    )?.handler;
  },
}));

vi.mock('@common/state', () => ({
  workspaceSM: { get: mocks.workspaceSMGet },
}));

vi.mock('@frontend/latex/openBuild', () => ({
  prepareBuildDisplay: mocks.prepareBuildDisplay,
  scheduleViewerDisplay: mocks.scheduleViewerDisplay,
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: mocks.showLoggedErrorMessage,
  showLoggedInfoMessage: mocks.showLoggedInfoMessage,
  showLoggedMessage: mocks.showLoggedMessage,
  showLoggedMessageWithDocs: mocks.showLoggedMessageWithDocs,
}));

vi.mock('@housekeeping/packLatexdiffvc', () => ({
  runPackLatexdiffvc: vi.fn(),
}));

vi.mock('@latex/latexdiff/runLatexdiff', () => ({
  normalizeRunLatexdiffOutputsByRound:
    mocks.normalizeRunLatexdiffOutputsByRound,
  runLatexdiffForExecution: mocks.runLatexdiffForExecution,
}));

vi.mock('@latex/latexdiff/service', () => ({
  CHANNEL: 'LaTeXCommands',
  latexdiffService: {},
}));

vi.mock('@latex/latexdiff/mathMarkup', () => ({
  DEFAULT_MATH_MARKUP: 'full',
  MATH_MARKUP_OPTIONS: ['full'],
  describeMathMarkupOption: vi.fn(() => 'Full'),
}));

vi.mock('@logger/logUtils', () => ({
  createLog: (channel: string) => ({
    warn: (message: string) => mocks.warn(channel, message),
    debug: (message: string) => mocks.debug(channel, message),
    info: (message: string) => mocks.info(channel, message),
    error: (message: string) => mocks.error(channel, message),
  }),
  warn: mocks.warn,
  debug: mocks.debug,
  info: mocks.info,
  error: mocks.error,
}));

vi.mock('@shared/state/stateKeys', () => ({
  WorkspaceStateKey: {
    LATEXDIFF_MATH_MARKUP: 'latexdiff.mathMarkup',
    LATEXDIFF_BETWEEN_ROUNDS: 'latexdiff.betweenRounds',
  },
}));

vi.mock('@shared/constants/latexConfig', () => ({
  LATEX_CONFIG_DEFAULTS: { latexdiffBetweenRounds: false },
}));

vi.mock('@utils/files/absoluteFS', () => ({
  AbsoluteFS: { exists: mocks.exists },
}));

vi.mock('@utils/files/fileLocation', () => ({
  pathToLocation: mocks.pathToLocation,
}));

vi.mock('@utils/system/toolUtils', () => ({
  checkToolInstalled: mocks.checkToolInstalled,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (filePath: string) => ({
      fsPath: filePath,
      path: filePath,
      toString: () => filePath,
    }),
  },
  ProgressLocation: { Notification: 1 },
  window: {
    showTextDocument: mocks.showTextDocument,
    showQuickPick: mocks.showQuickPick,
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    withProgress: mocks.withProgress,
  },
  workspace: {
    openTextDocument: mocks.openTextDocument,
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: (_section?: string) => ({
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
    }),
  },
}));

import { registerLatexdiffCommands } from '@commands/latex/latexdiffCommands';

const mixedResults = [
  { success: true, diffPath: '/workspace/diff-1.tex' },
  { success: true, diffPath: '/tmp/diff-2.tex' },
];

const runConfig = {
  agent: 'writer',
  model: 'test-model',
  inputFile: 'paper.tex',
};

describe('texra.runLatexdiff result preparation and final viewer delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runLatexdiffHandler = undefined;
    mocks.exists.mockResolvedValue(true);
    mocks.prepareBuildDisplay.mockImplementation(async () => true);
    mocks.scheduleViewerDisplay.mockResolvedValue(true);
    mocks.showLoggedMessage.mockResolvedValue(undefined);
    mocks.showLoggedErrorMessage.mockResolvedValue(undefined);
    mocks.showLoggedInfoMessage.mockResolvedValue(undefined);
    mocks.showLoggedMessageWithDocs.mockResolvedValue(undefined);
    mocks.checkToolInstalled.mockResolvedValue(true);
    mocks.normalizeRunLatexdiffOutputsByRound.mockReturnValue(null);
    mocks.runLatexdiffForExecution.mockResolvedValue({
      outcome: { results: mixedResults },
    });
    mocks.workspaceSMGet.mockReturnValue(false);
    mocks.showQuickPick.mockResolvedValue({ value: 'full' });
    mocks.showInformationMessage.mockResolvedValue(undefined);
    mocks.showWarningMessage.mockResolvedValue(undefined);
    mocks.withProgress.mockImplementation(
      async (
        _options: unknown,
        task: (progress: {
          report: (value: unknown) => void;
        }) => Promise<unknown>,
      ) => task({ report: vi.fn() }),
    );
    mocks.openTextDocument.mockImplementation(async (uri: unknown) => ({
      uri,
    }));
    mocks.showTextDocument.mockResolvedValue(undefined);

    registerLatexdiffCommands({} as never);
  });

  it('restores the last viewer-ready diff after a later non-viewer-ready external compile', async () => {
    mocks.prepareBuildDisplay.mockImplementation(
      async (location: { kind: string }) => location.kind === 'workspace',
    );

    await mocks.runLatexdiffHandler?.(runConfig);

    expect(mocks.prepareBuildDisplay).toHaveBeenCalledTimes(2);
    expect(mocks.scheduleViewerDisplay).toHaveBeenCalledTimes(1);
    expect(mocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/diff-1.tex' }),
    );
    expect(mocks.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('skips the final viewer when restoring the last viewer-ready diff fails', async () => {
    mocks.prepareBuildDisplay.mockImplementation(
      async (location: { kind: string }) => location.kind === 'workspace',
    );
    mocks.openTextDocument.mockRejectedValueOnce(new Error('restore failed'));

    await mocks.runLatexdiffHandler?.(runConfig);

    expect(mocks.scheduleViewerDisplay).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      'LaTeXCommands',
      expect.stringContaining('Failed to restore the last prepared diff'),
    );
  });

  it('schedules the final viewer for the last prepared diff when a later setup rejects', async () => {
    mocks.prepareBuildDisplay.mockImplementation(
      async (location: { absolutePath: string }) => {
        if (location.absolutePath === '/workspace/diff-1.tex') return true;
        throw new Error('second setup failed');
      },
    );

    await mocks.runLatexdiffHandler?.(runConfig);

    expect(mocks.showLoggedErrorMessage).toHaveBeenCalledWith(
      'LaTeXCommands',
      'Error running LaTeX diffs',
      expect.any(Error),
    );
    expect(mocks.scheduleViewerDisplay).toHaveBeenCalledTimes(1);
    expect(mocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/diff-1.tex' }),
    );
  });
});
