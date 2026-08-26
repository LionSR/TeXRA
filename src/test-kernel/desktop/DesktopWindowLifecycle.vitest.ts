import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  installBeforeQuitHandler,
  installRendererNavigationCleanup,
  installUnsavedChangesHandler,
} from '@desktop/main/desktopWindowLifecycle';

class FakeWebContents extends EventEmitter {}

describe('desktop window lifecycle', () => {
  it('skips initial renderer navigation and cleans up on reload', () => {
    const webContents = new FakeWebContents();
    const disposeRendererResources = vi.fn();
    installRendererNavigationCleanup(webContents, { disposeRendererResources });
    webContents.emit('did-navigate');
    expect(disposeRendererResources).not.toHaveBeenCalled();
    webContents.emit('did-navigate');
    expect(disposeRendererResources).toHaveBeenCalledOnce();
  });

  it('allows discard and clears continuations when editing continues', () => {
    const webContents = new FakeWebContents();
    const clearPendingWorkspaceRelaunch = vi.fn();
    const clearContinueQuitAfterWindowClose = vi.fn();
    const showDiscardDialog = vi.fn(() => 0);
    installUnsavedChangesHandler({
      webContents,
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
  });

  it('closes a live window before running shutdown on the subsequent quit', async () => {
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
    const runShutdown = vi.fn(async () => {});
    const continueAfterWindowClose = vi.fn();
    installBeforeQuitHandler({
      app,
      getMainWindow: () => window,
      lifecycle: { runShutdown },
      continueAfterWindowClose,
    });
    const first = { preventDefault: vi.fn() };
    listener?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(runShutdown).not.toHaveBeenCalled();
    window = null;
    const second = { preventDefault: vi.fn() };
    listener?.(second);
    await vi.waitFor(() => expect(runShutdown).toHaveBeenCalledOnce());
    expect(second.preventDefault).toHaveBeenCalledOnce();
  });
});
