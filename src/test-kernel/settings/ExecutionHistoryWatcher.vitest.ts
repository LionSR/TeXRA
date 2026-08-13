// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { HistoryHandlers } from '@settingsView/handlers/historyHandlers';
import { createDeferred } from '@test/support/asyncTestUtils';
import { StorageFS } from '@utils/files/storageFS';

const mocks = vi.hoisted(() => ({
  workspaceFoldersListeners: [] as Array<() => void>,
}));

// The shared vscode stub predates workspace-folder listeners; capture them so
// tests drive re-registration through the same event the extension host fires.
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      onDidChangeWorkspaceFolders: (listener: () => void) => {
        mocks.workspaceFoldersListeners.push(listener);
        return { dispose: vi.fn() };
      },
    },
  };
});

type HandlerFixture = {
  handler: SettingsViewMessageHandler;
  /** Fires the workspace-folders-changed event the handler subscribes to. */
  fireWorkspaceFoldersChanged(): void;
  /** Disposes every subscription the constructor registered (view teardown). */
  disposeSubscriptions(): void;
};

/**
 * The watcher registers only while a settings webview is visible (#9959), so
 * every scenario below drives registration through a dispatch from a fake
 * panel plus its visibility events, and teardown through the context
 * subscriptions the constructor registered.
 */
function createHandler(): HandlerFixture {
  const subscriptions: Array<{ dispose(): void }> = [];
  const handler = new SettingsViewMessageHandler({
    subscriptions,
    extensionPath: '/ext',
  } as unknown as vscode.ExtensionContext);
  return {
    handler,
    fireWorkspaceFoldersChanged: () => {
      for (const listener of mocks.workspaceFoldersListeners) listener();
    },
    disposeSubscriptions: () => {
      for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
      }
    },
  };
}

type ViewFixture = {
  view: vscode.WebviewPanel;
  setVisible(visible: boolean): void;
};

function createView(visible = true): ViewFixture {
  const listeners: Array<() => void> = [];
  const view = {
    visible,
    viewColumn: 1,
    onDidChangeViewState: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    },
    webview: { postMessage: vi.fn(async () => true) },
  };
  return {
    view: view as unknown as vscode.WebviewPanel,
    setVisible: (next: boolean) => {
      view.visible = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * Any dispatch attaches visibility tracking (`onDispatch` runs before the
 * command is resolved), so an unknown command exercises nothing else.
 */
function attach(
  handler: SettingsViewMessageHandler,
  view: vscode.WebviewPanel,
): Promise<void> {
  return handler.handleMessage({ command: 'visibility-probe' }, view);
}

/** Let queued registration continuations (microtasks) run to completion. */
function flushRegistrations(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function watcher(): vscode.FileSystemWatcher {
  return {
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    ignoreChangeEvents: false,
    ignoreCreateEvents: false,
    ignoreDeleteEvents: false,
  };
}

describe('settings execution history watcher', () => {
  let sendHistoryData: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.workspaceFoldersListeners.length = 0;
    // The on-show refresh lists executions from storage; the lifecycle under
    // test only cares that the refresh was requested.
    sendHistoryData = vi
      .spyOn(HistoryHandlers.prototype, 'sendHistoryData')
      .mockResolvedValue(undefined) as ReturnType<typeof vi.spyOn>;
    vi.spyOn(StorageFS, 'ensureDir').mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('registers only once a visible view dispatches, not on construction', async () => {
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockReturnValue(watcher());

    const fixture = createHandler();
    fixture.fireWorkspaceFoldersChanged();
    await flushRegistrations();
    expect(createWatcher).not.toHaveBeenCalled();

    await attach(fixture.handler, createView().view);
    await vi.waitFor(() => expect(createWatcher).toHaveBeenCalledOnce());
  });

  it('does not register while the view is hidden', async () => {
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockReturnValue(watcher());

    const fixture = createHandler();
    const { view, setVisible } = createView(false);
    await attach(fixture.handler, view);
    await flushRegistrations();
    expect(createWatcher).not.toHaveBeenCalled();

    setVisible(true);
    await vi.waitFor(() => expect(createWatcher).toHaveBeenCalledOnce());
  });

  it('disposes the watcher on hide and re-registers with one refresh on show', async () => {
    const firstWatcher = watcher();
    const secondWatcher = watcher();
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValue(secondWatcher);

    const fixture = createHandler();
    const { view, setVisible } = createView();
    await attach(fixture.handler, view);
    await vi.waitFor(() => expect(createWatcher).toHaveBeenCalledOnce());
    // The attach dispatch produces its own data; no extra refresh on it.
    expect(sendHistoryData).not.toHaveBeenCalled();

    setVisible(false);
    expect(firstWatcher.dispose).toHaveBeenCalledOnce();

    setVisible(true);
    await vi.waitFor(() => expect(createWatcher).toHaveBeenCalledTimes(2));
    expect(sendHistoryData).toHaveBeenCalledOnce();
    expect(secondWatcher.dispose).not.toHaveBeenCalled();
  });

  it('tears the watcher down when the view is cleared', async () => {
    const currentWatcher = watcher();
    vi.spyOn(vscode.workspace, 'createFileSystemWatcher').mockReturnValue(
      currentWatcher,
    );

    const fixture = createHandler();
    await attach(fixture.handler, createView().view);
    await vi.waitFor(() =>
      expect(currentWatcher.onDidCreate).toHaveBeenCalled(),
    );

    fixture.handler.clearActiveView();
    expect(currentWatcher.dispose).toHaveBeenCalledOnce();
  });

  it('logs and absorbs directory setup failures', async () => {
    const failure = new Error('permission denied');
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(failure);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const fixture = createHandler();
    await attach(fixture.handler, createView().view);

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        'SettingsViewMessageHandler',
        'Failed to register execution history watcher: permission denied',
      );
    });
  });

  it('keeps the newest watcher when setup completes out of order', async () => {
    const firstSetup = createDeferred();
    const secondSetup = createDeferred();
    vi.spyOn(StorageFS, 'ensureDir')
      .mockImplementationOnce(() => firstSetup.promise)
      .mockImplementationOnce(() => secondSetup.promise)
      .mockResolvedValue(undefined);
    const currentWatcher = watcher();
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockReturnValue(currentWatcher);

    // The attach registration pends on firstSetup; the folder-change
    // re-registration pends on secondSetup and wins the generation race.
    const fixture = createHandler();
    await attach(fixture.handler, createView().view);
    fixture.fireWorkspaceFoldersChanged();
    secondSetup.resolve();
    await vi.waitFor(() => expect(createWatcher).toHaveBeenCalledOnce());
    firstSetup.resolve();
    await flushRegistrations();

    expect(createWatcher).toHaveBeenCalledTimes(1);
    expect(currentWatcher.dispose).not.toHaveBeenCalled();

    // The next re-registration invalidates (disposes) whichever watcher is
    // live — proving the out-of-order loser never got published.
    fixture.fireWorkspaceFoldersChanged();
    expect(currentWatcher.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a candidate made stale by synchronous reentrancy', async () => {
    const staleWatcher = watcher();
    const currentWatcher = watcher();
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockImplementationOnce(() => {
        // A folder change lands while the attach registration is mid-setup:
        // its candidate is stale the moment it returns.
        fixture.fireWorkspaceFoldersChanged();
        return staleWatcher;
      })
      .mockReturnValue(currentWatcher);
    const fixture = createHandler();
    await attach(fixture.handler, createView().view);

    await vi.waitFor(() => expect(createWatcher).toHaveBeenCalledTimes(2));
    await flushRegistrations();

    expect(staleWatcher.dispose).toHaveBeenCalledOnce();
    expect(currentWatcher.dispose).not.toHaveBeenCalled();

    fixture.fireWorkspaceFoldersChanged();
    expect(currentWatcher.dispose).toHaveBeenCalledOnce();
  });

  it('invalidates setup still pending during teardown', async () => {
    const setup = createDeferred();
    vi.spyOn(StorageFS, 'ensureDir').mockReturnValue(setup.promise);
    const createWatcher = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
    const fixture = createHandler();
    await attach(fixture.handler, createView().view);

    fixture.disposeSubscriptions();
    setup.resolve();
    await flushRegistrations();

    expect(createWatcher).not.toHaveBeenCalled();
  });
});
