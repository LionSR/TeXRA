// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopProgressIpcModule {
  createDesktopProgressIpc(options: {
    progress: {
      syncFullView(): void;
      progressViewInboundHandlers: ProgressViewInboundHandlerRegistry;
    };
    onUnsupportedCommand?: (message: { command: string }) => void;
    onAsyncError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

async function loadDesktopProgressIpc(): Promise<DesktopProgressIpcModule> {
  vi.resetModules();
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopProgressIpc.ts'))
  ) as Promise<DesktopProgressIpcModule>;
}

function createProgress(
  progressViewInboundHandlers: ProgressViewInboundHandlerRegistry = {},
) {
  return {
    syncFullView: vi.fn(),
    progressViewInboundHandlers,
  };
}

describe('desktop Progress IPC', () => {
  it('syncs Progress state on readiness while allowing shared view-state handling', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({ command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY }),
    ).toBe(false);
    expect(progress.syncFullView).toHaveBeenCalledTimes(1);
  });

  it('dispatches recognized Progress commands through the bridge registry', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const switchStream = vi.fn();
    const progress = createProgress({
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: switchStream,
    });
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(switchStream).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
    });
  });

  it('consumes recognized but unhandled commands with an explicit warning path', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress: createProgress(),
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(onUnsupportedCommand).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
      stream: 'run-1',
    });
  });

  it('leaves shell-level pass-through commands for sibling desktop handlers', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress: createProgress(),
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_VIEW,
        view: 'progress',
      }),
    ).toBe(false);
    expect(onUnsupportedCommand).not.toHaveBeenCalled();
  });

  it('reports async registry failures through the desktop error path', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const error = new Error('dispatch failed');
    const onAsyncError = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress: createProgress({
        [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: () => Promise.reject(error),
      }),
      onAsyncError,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(onAsyncError).toHaveBeenCalledWith(error);
    });
  });

  it('ignores invalid Progress IPC payloads', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const ipc = createDesktopProgressIpc({ progress: createProgress() });

    expect(ipc.handleMessage({ command: 'not-a-progress-command' })).toBe(
      false,
    );
  });
});
