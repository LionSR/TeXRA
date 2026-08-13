import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';
import { unsupported } from '@shared/utils/dispatcher';

import { loadSourceModule } from './loadSourceModule.ts';

/** Default reason for the handlers this test doesn't stub explicitly. */
const NOT_UNDER_TEST = 'not covered by this test';

/**
 * Pads a partial handler stub with `unsupported(NOT_UNDER_TEST)` for every
 * other command so it satisfies the exhaustive registry type. This suite
 * only exercises the desktop IPC's dispatch mechanics (recognized/pass-
 * through/unhandled), not real per-command coverage.
 */
function fillRegistry(
  partial: Partial<ProgressViewInboundHandlerRegistry> = {},
): ProgressViewInboundHandlerRegistry {
  const full: Record<string, unknown> = {};
  for (const command of new Set(Object.values(PROGRESS_VIEW_COMMANDS))) {
    full[command] =
      (partial as Record<string, unknown>)[command] ??
      unsupported(NOT_UNDER_TEST);
  }
  return full as ProgressViewInboundHandlerRegistry;
}

type DesktopProgressIpcModule =
  typeof import('@desktop/main/desktopProgressIpc');

async function loadDesktopProgressIpc(): Promise<DesktopProgressIpcModule> {
  vi.resetModules();
  return loadSourceModule('@desktop/main/desktopProgressIpc');
}

function createProgress(
  progressViewInboundHandlers: Partial<ProgressViewInboundHandlerRegistry> = {},
) {
  return {
    completeWebviewReady: vi.fn(async () => undefined),
    progressViewInboundHandlers: fillRegistry(progressViewInboundHandlers),
  };
}

function readySource(progress: ReturnType<typeof createProgress>) {
  return { get: () => progress, ensure: async () => progress };
}

describe('desktop Progress IPC', () => {
  let createDesktopProgressIpc: DesktopProgressIpcModule['createDesktopProgressIpc'];
  beforeEach(async () => {
    ({ createDesktopProgressIpc } = await loadDesktopProgressIpc());
  });

  it('syncs Progress state on readiness while allowing shared view-state handling', async () => {
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ source: readySource(progress) });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'progress',
      }),
    ).toBe(false);
    await Promise.resolve();

    expect(progress.completeWebviewReady).toHaveBeenCalledTimes(1);
  });

  it('ignores main-view readiness broadcasts for Progress prompt replay', async () => {
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({ source: readySource(progress) });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);

    expect(progress.completeWebviewReady).not.toHaveBeenCalled();
  });

  it('replays pending prompts after lazy Progress readiness load', async () => {
    const progress = createProgress();
    const ipc = createDesktopProgressIpc({
      source: {
        get: () => undefined,
        ensure: async () => progress,
      },
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'progress',
      }),
    ).toBe(false);
    await Promise.resolve();

    expect(progress.completeWebviewReady).toHaveBeenCalledTimes(1);
  });

  it('dispatches recognized Progress commands through the bridge registry', async () => {
    const switchStream = vi.fn();
    const progress = createProgress({
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: switchStream,
    });
    const ipc = createDesktopProgressIpc({ source: readySource(progress) });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
        requestId: 'request-1',
      }),
    ).toBe(true);
    expect(switchStream).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
      requestId: 'request-1',
    });
  });

  it('loads a lazy Progress bridge before dispatching recognized commands', async () => {
    const switchStream = vi.fn();
    const progress = createProgress({
      [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: switchStream,
    });
    const ensure = vi.fn(async () => progress);
    const ipc = createDesktopProgressIpc({
      source: { get: () => undefined, ensure },
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
        requestId: 'request-2',
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(switchStream).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
      stream: 'run-1',
      requestId: 'request-2',
    });
  });

  it('consumes recognized but unhandled commands with an explicit warning path', async () => {
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      source: readySource(createProgress()),
      onUnsupportedCommand,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.STOP_STREAM,
        stream: 'run-1',
      }),
    ).toBe(true);
    expect(onUnsupportedCommand).toHaveBeenCalledWith(
      { command: PROGRESS_VIEW_COMMANDS.STOP_STREAM, stream: 'run-1' },
      NOT_UNDER_TEST,
    );
  });

  it('leaves shell-level pass-through commands for sibling desktop handlers', async () => {
    const onUnsupportedCommand = vi.fn();
    const ipc = createDesktopProgressIpc({
      source: readySource(createProgress()),
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
    const error = new Error('dispatch failed');
    const onAsyncError = vi.fn();
    const ipc = createDesktopProgressIpc({
      source: readySource(
        createProgress({
          [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: () => Promise.reject(error),
        }),
      ),
      onAsyncError,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.SWITCH_STREAM,
        stream: 'run-1',
        requestId: 'request-3',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(onAsyncError).toHaveBeenCalledWith(error);
  });

  it('reports a failed webviewReady sequence through the desktop error path', async () => {
    const error = new Error('restart repair failed');
    const onAsyncError = vi.fn();
    const progress = {
      completeWebviewReady: vi.fn(() => Promise.reject(error)),
      progressViewInboundHandlers: fillRegistry(),
    };
    const ipc = createDesktopProgressIpc({
      source: readySource(progress),
      onAsyncError,
    });

    expect(
      ipc.handleMessage({
        command: PROGRESS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'progress',
      }),
    ).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAsyncError).toHaveBeenCalledWith(error);
  });

  it('ignores invalid Progress IPC payloads', async () => {
    const ipc = createDesktopProgressIpc({
      source: readySource(createProgress()),
    });

    expect(ipc.handleMessage({ command: 'not-a-progress-command' })).toBe(
      false,
    );
  });
});
