import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { LATEX_VIEWER_OPEN_DELAY_MS } from '@shared/constants/latexTiming';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async (_path: string) => true),
  isLatexFile: vi.fn((_path: string) => true),
  compileLatex2Pdf: vi.fn(async () => ({ ok: true as const, logTail: '' })),
  pathToLocation: vi.fn((absolutePath: string) => ({
    kind: 'workspace' as const,
    absolutePath,
    relativePath: 'paper.tex',
  })),
  executeCommand: vi.fn(
    async (_command: string, ..._args: unknown[]) => undefined,
  ),
  openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
  showTextDocument: vi.fn(async () => undefined),
  showErrorMessage: vi.fn(async () => undefined),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  showLoggedMessage: vi.fn(async (_channel: string, _message: string) => ''),
}));

vi.mock('@utils/files/absoluteFS', () => ({
  AbsoluteFS: { exists: mocks.exists },
}));

vi.mock('@common/files/fileTypeUtils', () => ({
  isLatexFile: mocks.isLatexFile,
}));

vi.mock('@utils/files/fileLocation', () => ({
  pathToLocation: mocks.pathToLocation,
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedMessage: mocks.showLoggedMessage,
}));

vi.mock('@logger/logUtils', () => ({
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
    mocks.executeCommand.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports non-delivery when the PDF viewer open rejects', async () => {
    mocks.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'latex-workshop.view') {
        throw new Error('viewer unavailable');
      }
      return undefined;
    });

    const delivery = openBuildDisplayIfTex(workspaceTex);
    // Flush the setup chain (exists -> openTextDocument -> showTextDocument ->
    // latex-workshop.build) before advancing the clock so the viewer-open timer
    // is actually registered when the 5s advance runs (#10555).
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);

    await expect(delivery).resolves.toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith(
      'OpenBuildUtils',
      expect.stringContaining('Viewer display failed'),
    );
  });

  it('reports delivery only once the viewer-open command has settled', async () => {
    let settled = false;
    const delivery = openBuildDisplayIfTex(workspaceTex).then((delivered) => {
      settled = true;
      return delivered;
    });

    // Flush the setup chain first so the `settled` boundary is measured against
    // the viewer-open timer rather than against the pending setup microtasks.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(delivery).resolves.toBe(true);
    expect(mocks.executeCommand).toHaveBeenCalledWith('latex-workshop.view');
  });

  it('keeps workspace LaTeX Workshop build failures out of the delivery boolean', async () => {
    mocks.executeCommand.mockImplementation(async (command: string) => {
      if (command === 'latex-workshop.build') {
        throw new Error('build failed');
      }
      return undefined;
    });

    const delivery = openBuildDisplayIfTex(workspaceTex);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);

    await expect(delivery).resolves.toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(
      'OpenBuildUtils',
      expect.stringContaining('LaTeX Workshop build failed'),
    );
  });

  it('settles the delivery promise when the viewer-open command throws synchronously', async () => {
    // A synchronous throw from `executeCommand('latex-workshop.view')` must
    // become a rejection that resolves `false`, not leave the promise pending
    // forever (#10556).
    mocks.executeCommand.mockImplementation((command: string) => {
      if (command === 'latex-workshop.view') {
        throw new Error('viewer unavailable');
      }
      return Promise.resolve(undefined);
    });

    const delivery = openBuildDisplayIfTex(workspaceTex);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);

    await expect(delivery).resolves.toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith(
      'OpenBuildUtils',
      expect.stringContaining('Viewer display failed'),
    );
  });
});
