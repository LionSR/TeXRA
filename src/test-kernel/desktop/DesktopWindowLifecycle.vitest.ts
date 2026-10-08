import { EventEmitter } from 'node:events';

import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapDesktopWindowLifecycle,
  installDesktopBeforeQuitWiring,
} from '@desktop/main/desktopWindowLifecycle';
import { createDesktopWindows } from '@desktop/main/desktopWindows';
import { createDeferred } from '@test/support/asyncTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import type { BrowserWindow } from 'electron';

class FakeWebContents extends EventEmitter {}

describe('desktop window lifecycle', () => {
  it('skips initial renderer navigation and cleans up on reload', () => {
    const webContents = new FakeWebContents();
    const disposeRendererResources = vi.fn();
    bootstrapDesktopWindowLifecycle({
      webContents,
      workspaceIpc: { disposeRendererResources },
      showDiscardDialog: () => 0,
      isFatalShutdownRequested: () => false,
      clearContinueQuitAfterWindowClose: vi.fn(),
    });
    webContents.emit('did-navigate');
    expect(disposeRendererResources).not.toHaveBeenCalled();
    webContents.emit('did-navigate');
    expect(disposeRendererResources).toHaveBeenCalledOnce();
  });

  it('allows discard and clears continuations when editing continues', () => {
    const webContents = new FakeWebContents();
    const clearContinueQuitAfterWindowClose = vi.fn();
    const showDiscardDialog = vi.fn(() => 0);
    bootstrapDesktopWindowLifecycle({
      webContents,
      workspaceIpc: { disposeRendererResources: vi.fn() },
      showDiscardDialog,
      isFatalShutdownRequested: () => false,
      clearContinueQuitAfterWindowClose,
    });
    const keepEditing = { preventDefault: vi.fn() };
    showDiscardDialog.mockReturnValueOnce(0);
    webContents.emit('will-prevent-unload', keepEditing);
    expect(keepEditing.preventDefault).not.toHaveBeenCalled();
    expect(clearContinueQuitAfterWindowClose).toHaveBeenCalledOnce();

    const discard = { preventDefault: vi.fn() };
    showDiscardDialog.mockReturnValueOnce(1);
    webContents.emit('will-prevent-unload', discard);
    expect(discard.preventDefault).toHaveBeenCalledOnce();

    const fatal = { preventDefault: vi.fn() };
    const fatalWebContents = new FakeWebContents();
    bootstrapDesktopWindowLifecycle({
      webContents: fatalWebContents,
      workspaceIpc: { disposeRendererResources: vi.fn() },
      showDiscardDialog,
      isFatalShutdownRequested: () => true,
      clearContinueQuitAfterWindowClose,
    });
    fatalWebContents.emit('will-prevent-unload', fatal);
    expect(fatal.preventDefault).toHaveBeenCalledOnce();
    expect(showDiscardDialog).toHaveBeenCalledTimes(2);
  });

  it('continues a closed-window quit through one shutdown sequence', async () => {
    let listener: ((event: { preventDefault(): void }) => void) | undefined;
    const app = {
      on: vi.fn((_event, handler) => {
        listener = handler;
      }),
      quit: vi.fn(),
    };
    const close = vi.fn();
    let window: { close(): void; isDestroyed(): boolean } | null = {
      close,
      isDestroyed: () => false,
    };
    const sequence: string[] = [];
    const shutdownRan = createDeferred();
    const ranShutdown = vi.fn(() => {
      sequence.push('shutdown');
      shutdownRan.resolve();
    });
    const shutdown = Effect.sync(ranShutdown);
    let continueQuit: (() => void) | undefined;
    const continueAfterWindowClose = vi.fn((continuation: () => void) => {
      continueQuit = continuation;
    });
    installDesktopBeforeQuitWiring({
      app,
      getMainWindow: () => window,
      shutdown,
      continueAfterWindowClose,
    });
    const first = { preventDefault: vi.fn() };
    listener?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(continueAfterWindowClose).toHaveBeenCalledOnce();
    expect(ranShutdown).not.toHaveBeenCalled();

    window = null;
    continueQuit?.();
    const second = { preventDefault: vi.fn() };
    listener?.(second);
    await shutdownRan.promise;
    expect(ranShutdown).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(sequence).toEqual(['shutdown']);

    listener?.({ preventDefault: vi.fn() });
    expect(ranShutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
  });

  it('reopens through an open that waits on the service, once, revealing after it', async () => {
    // The open waits, as one attaching the window to the background service
    // waits on the IPC handshake.
    const attached = createDeferred();
    const open = vi.fn();
    const revealed: string[] = [];
    // The registry reads only the window's `closed` event and `isDestroyed`.
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
    }) as unknown as BrowserWindow;
    const windows = createDesktopWindows({
      runtime: testRuntime(),
      open: () =>
        Effect.andThen(
          Effect.sync(open),
          Effect.promise(() => attached.promise),
        ).pipe(Effect.as({ window, reveal: vi.fn() })),
    });

    windows.reopen();
    // A second activate and an attention click land before the handshake.
    windows.reopen();
    windows.focus(() => revealed.push(windows.window() ? 'open' : 'missing'));
    expect(windows.window()).toBeNull();

    attached.resolve();
    await vi.waitFor(() => expect(revealed).toEqual(['open']));
    expect(open).toHaveBeenCalledOnce();
    expect(windows.window()).toBe(window);
  });
});
