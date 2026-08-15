import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareLatexdiffResultsAndScheduleViewer } from '@commands/latex/latexdiffResultDelivery';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  prepareBuildDisplay: vi.fn(),
  scheduleViewerDisplay: vi.fn(),
  showLoggedMessage: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
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
}));

vi.mock('@frontend/latex/openBuild', () => ({
  prepareBuildDisplay: mocks.prepareBuildDisplay,
  scheduleViewerDisplay: mocks.scheduleViewerDisplay,
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessage: mocks.showLoggedMessage,
}));

vi.mock('@logger/logUtils', () => ({
  warn: mocks.warn,
  debug: mocks.debug,
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@utils/files/absoluteFS', () => ({
  AbsoluteFS: { exists: mocks.exists },
}));

vi.mock('@utils/files/fileLocation', () => ({
  pathToLocation: mocks.pathToLocation,
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (filePath: string) => ({
      fsPath: filePath,
      path: filePath,
      toString: () => filePath,
    }),
  },
  window: { showTextDocument: mocks.showTextDocument },
  workspace: { openTextDocument: mocks.openTextDocument },
}));

const mixedResults = [
  {
    success: true,
    basePath: '/workspace/base.tex',
    diffFileName: 'diff-1.tex',
  },
  {
    success: true,
    basePath: '/tmp/base.tex',
    diffFileName: 'diff-2.tex',
  },
];

describe('latexdiff result preparation and final viewer delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exists.mockResolvedValue(true);
    mocks.prepareBuildDisplay.mockImplementation(async () => true);
    mocks.scheduleViewerDisplay.mockResolvedValue(true);
    mocks.showLoggedMessage.mockResolvedValue(undefined);
    mocks.openTextDocument.mockImplementation(async (uri: unknown) => ({
      uri,
    }));
    mocks.showTextDocument.mockResolvedValue(undefined);
  });

  it('restores the last viewer-ready diff after a later non-viewer-ready external compile', async () => {
    mocks.prepareBuildDisplay.mockImplementation(
      async (location: { kind: string }) => location.kind === 'workspace',
    );

    await prepareLatexdiffResultsAndScheduleViewer(mixedResults);

    expect(mocks.prepareBuildDisplay).toHaveBeenCalledTimes(2);
    expect(mocks.scheduleViewerDisplay).toHaveBeenCalledTimes(1);
    expect(mocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/diff-1.tex' }),
    );
    expect(mocks.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('schedules the final viewer for the last prepared diff when a later setup rejects', async () => {
    mocks.prepareBuildDisplay.mockImplementation(
      async (location: { absolutePath: string }) => {
        if (location.absolutePath === '/workspace/diff-1.tex') return true;
        throw new Error('second setup failed');
      },
    );

    await expect(
      prepareLatexdiffResultsAndScheduleViewer(mixedResults),
    ).rejects.toThrow('second setup failed');

    expect(mocks.scheduleViewerDisplay).toHaveBeenCalledTimes(1);
    expect(mocks.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/workspace/diff-1.tex' }),
    );
  });
});
