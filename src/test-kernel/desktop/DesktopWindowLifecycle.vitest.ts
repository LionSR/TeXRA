import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  installDesktopBeforeQuitWiring,
  installDesktopWindowLifecycleWiring,
} from '@desktop/main/desktopWindowLifecycle';

class FakeWebContents extends EventEmitter {}

describe('desktop window lifecycle', () => {
  it('skips initial renderer navigation and cleans up on reload', () => {
    const webContents = new FakeWebContents();
    const disposeRendererResources = vi.fn();
    installDesktopWindowLifecycleWiring({
      webContents,
      workspaceIpc: { disposeRendererResources },
      showDiscardDialog: () => 0,
      isFatalShutdownRequested: () => false,
      clearPendingWorkspaceRelaunch: vi.fn(),
      clearContinueQuitAfterWindowClose: vi.fn(),
    });
    webContents.emit('did-navigate');
    expect(disposeRendererResources).not.toHaveBeenCalled();
    webContents.emit('did-navigate');
    expect(disposeRendererResources).toHaveBeenCalledOnce();
  });

  it('installs navigation cleanup and unsaved-change handling on one window webContents', () => {
    const webContents = new FakeWebContents();
    const disposeRendererResources = vi.fn();
    const discard = { preventDefault: vi.fn() };

    installDesktopWindowLifecycleWiring({
      webContents,
      workspaceIpc: { disposeRendererResources },
      showDiscardDialog: () => 1,
      isFatalShutdownRequested: () => false,
      clearPendingWorkspaceRelaunch: vi.fn(),
      clearContinueQuitAfterWindowClose: vi.fn(),
    });

    webContents.emit('will-prevent-unload', discard);
    expect(discard.preventDefault).toHaveBeenCalledOnce();
    webContents.emit('did-navigate');
    webContents.emit('did-navigate');
    expect(disposeRendererResources).toHaveBeenCalledOnce();
  });

  it('allows discard and clears continuations when editing continues', () => {
    const webContents = new FakeWebContents();
    const clearPendingWorkspaceRelaunch = vi.fn();
    const clearContinueQuitAfterWindowClose = vi.fn();
    const showDiscardDialog = vi.fn(() => 0);
    installDesktopWindowLifecycleWiring({
      webContents,
      workspaceIpc: { disposeRendererResources: vi.fn() },
      showDiscardDialog,
      isFatalShutdownRequested: () => false,
      clearPendingWorkspaceRelaunch,
      clearContinueQuitAfterWindowClose,
    });
    const keepEditing = { preventDefault: vi.fn() };
    showDiscardDialog.mockReturnValueOnce(0);
    webContents.emit('will-prevent-unload', keepEditing);
    expect(keepEditing.preventDefault).not.toHaveBeenCalled();
    expect(clearPendingWorkspaceRelaunch).toHaveBeenCalledOnce();
    expect(clearContinueQuitAfterWindowClose).toHaveBeenCalledOnce();

    const discard = { preventDefault: vi.fn() };
    showDiscardDialog.mockReturnValueOnce(1);
    webContents.emit('will-prevent-unload', discard);
    expect(discard.preventDefault).toHaveBeenCalledOnce();
    expect(clearPendingWorkspaceRelaunch).toHaveBeenCalledOnce();

    const fatal = { preventDefault: vi.fn() };
    const fatalWebContents = new FakeWebContents();
    const clearFatalRelaunch = vi.fn();
    installDesktopWindowLifecycleWiring({
      webContents: fatalWebContents,
      workspaceIpc: { disposeRendererResources: vi.fn() },
      showDiscardDialog,
      isFatalShutdownRequested: () => true,
      clearPendingWorkspaceRelaunch: clearFatalRelaunch,
      clearContinueQuitAfterWindowClose,
    });
    fatalWebContents.emit('will-prevent-unload', fatal);
    expect(fatal.preventDefault).toHaveBeenCalledOnce();
    expect(clearFatalRelaunch).toHaveBeenCalledOnce();
    expect(showDiscardDialog).toHaveBeenCalledTimes(2);
  });

  it('registers the composition-root before-quit listener', () => {
    const app = { on: vi.fn(), quit: vi.fn() };

    installDesktopBeforeQuitWiring({
      app,
      getMainWindow: () => null,
      lifecycle: { runShutdown: vi.fn(async () => {}) },
      continueAfterWindowClose: vi.fn(),
    });

    expect(app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
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
    const runShutdown = vi.fn(async () => {
      sequence.push('shutdown');
    });
    let continueQuit: (() => void) | undefined;
    const continueAfterWindowClose = vi.fn((continuation: () => void) => {
      continueQuit = continuation;
    });
    installDesktopBeforeQuitWiring({
      app,
      getMainWindow: () => window,
      lifecycle: { runShutdown },
      continueAfterWindowClose,
    });
    const first = { preventDefault: vi.fn() };
    listener?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(continueAfterWindowClose).toHaveBeenCalledOnce();
    expect(runShutdown).not.toHaveBeenCalled();

    window = null;
    continueQuit?.();
    const second = { preventDefault: vi.fn() };
    listener?.(second);
    await vi.waitFor(() => expect(runShutdown).toHaveBeenCalledOnce());
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
    expect(sequence).toEqual(['shutdown']);

    listener?.({ preventDefault: vi.fn() });
    expect(runShutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(2);
  });
});
