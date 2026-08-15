import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openBuildDisplayIfTex,
  prepareBuildDisplay,
  scheduleViewerDisplay,
} from '@frontend/latex/openBuild';
import {
  LATEX_VIEWER_OPEN_DELAY_MS,
  LATEX_VIEWER_REFRESH_DELAY_MS,
} from '@shared/constants/latexTiming';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(async (_path: string) => true),
  isLatexFile: vi.fn((_path: string) => true),
  compileLatex2Pdf: vi.fn(
    async (): Promise<{ ok: boolean; logTail: string }> => ({
      ok: true,
      logTail: '',
    }),
  ),
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
    mocks.compileLatex2Pdf.mockResolvedValue({ ok: true, logTail: '' });
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

  it('keeps viewer delivery true when the refresh command throws synchronously', async () => {
    // The refresh command is scheduled only after `latex-workshop.view` has
    // settled, so its synchronous throw must be warn-logged without downgrading
    // the already-established viewer delivery (#10556).
    mocks.executeCommand.mockImplementation((command: string) => {
      if (command === 'latex-workshop.refresh-viewer') {
        throw new Error('refresh unavailable');
      }
      return Promise.resolve(undefined);
    });

    const delivery = openBuildDisplayIfTex(workspaceTex);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_REFRESH_DELAY_MS);

    await expect(delivery).resolves.toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(
      'OpenBuildUtils',
      expect.stringContaining('Viewer refresh failed'),
    );
  });

  it('propagates pre-view failures before the detached viewer wait', async () => {
    // The detached path must still await and propagate file-open/build errors
    // so the latexdiff command's existing error handler stays authoritative.
    mocks.openTextDocument.mockRejectedValueOnce(new Error('open failed'));

    await expect(prepareBuildDisplay(workspaceTex)).rejects.toThrow(
      'open failed',
    );
    expect(mocks.executeCommand).not.toHaveBeenCalledWith(
      'latex-workshop.view',
    );
  });

  it('reports external compile failure as not viewer-ready', async () => {
    mocks.compileLatex2Pdf.mockResolvedValue({
      ok: false,
      logTail: 'compilation failed',
    });
    const externalTex = {
      kind: 'external' as const,
      absolutePath: '/tmp/paper.tex',
    };

    const ready = await prepareBuildDisplay(externalTex, {
      scheduleViewer: false,
    });
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);
    expect(mocks.executeCommand).not.toHaveBeenCalledWith(
      'latex-workshop.view',
    );
  });

  it('keeps the final viewer schedulable when a later prepare rejects', async () => {
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

    const first = { ...workspaceTex, absolutePath: '/workspace/diff-1.tex' };
    const second = { ...workspaceTex, absolutePath: '/workspace/diff-2.tex' };

    await prepareBuildDisplay(first, { scheduleViewer: false });
    await expect(
      prepareBuildDisplay(second, { scheduleViewer: false }),
    ).rejects.toThrow('second setup failed');

    // The command's try/finally schedules the final viewer for the last
    // prepared diff after the setup rejection propagates.
    void scheduleViewerDisplay();
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);

    const viewerIndexes = order
      .map((entry, index) => (entry === 'latex-workshop.view' ? index : -1))
      .filter((index) => index >= 0);
    expect(viewerIndexes).toHaveLength(1);
  });

  it('keeps final-result viewer delivery deterministic across sequential latexdiff results', async () => {
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
      await prepareBuildDisplay(diff, {
        preserveFocus: true,
        scheduleViewer: false,
      });
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
    void scheduleViewerDisplay();
    await vi.advanceTimersByTimeAsync(LATEX_VIEWER_OPEN_DELAY_MS);

    const viewerIndexes = order
      .map((entry, index) => (entry === 'latex-workshop.view' ? index : -1))
      .filter((index) => index >= 0);
    expect(viewerIndexes).toHaveLength(1);
    expect(viewerIndexes[0]).toBeGreaterThan(
      order.lastIndexOf('latex-workshop.build'),
    );
  });
});
