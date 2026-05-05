// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/progressViewCommands';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopProgressIpcModule {
  createDesktopProgressIpc(options: {
    progress: {
      syncFullView(): void;
      setActiveStream(stream: string): void;
      setAgentFilter(filter: string): void;
      deleteStream(stream: string): Promise<void>;
      deleteAllStreams(): Promise<void>;
    };
    onUnsupportedCommand?: (message: { command: string }) => void;
    onAsyncError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean | Promise<boolean>;
  };
}

async function loadDesktopProgressIpc(): Promise<DesktopProgressIpcModule> {
  vi.resetModules();
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopProgressIpc.ts'))
  ) as Promise<DesktopProgressIpcModule>;
}

function createProgress() {
  return {
    syncFullView: vi.fn(),
    setActiveStream: vi.fn(),
    setAgentFilter: vi.fn(),
    deleteStream: vi.fn(async (_stream: string) => {}),
    deleteAllStreams: vi.fn(async () => {}),
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

  it('handles basic Progress stream commands through the shared bridge', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ progress });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(progress.setActiveStream).toHaveBeenCalledWith('run-1');

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.FILTER_STREAMS,
        filter: 'workflow',
      }),
    ).toBe(true);
    expect(progress.setAgentFilter).toHaveBeenCalledWith('workflow');

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.DELETE_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(progress.deleteStream).toHaveBeenCalledWith('run-1');

    expect(
      ipc.handleMessage({ command: PROGRESS_VIEW_COMMANDS.DELETE_ALL }),
    ).toBe(true);
    await Promise.resolve();
    expect(progress.deleteAllStreams).toHaveBeenCalledTimes(1);
  });

  it('routes unsupported Progress commands through an explicit handler', async () => {
    const { createDesktopProgressIpc } = await loadDesktopProgressIpc();
    const progress = createProgress();
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      progress,
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

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_VIEW,
        view: 'progress',
      }),
    ).toBe(false);
    expect(onUnsupportedCommand).toHaveBeenCalledTimes(1);
  });
});
