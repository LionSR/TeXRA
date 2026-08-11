// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
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
  /** Fires the workspace-folders-changed event the handler subscribes to. */
  fireWorkspaceFoldersChanged(): void;
  /** Disposes every subscription the constructor registered (view teardown). */
  disposeSubscriptions(): void;
};

/**
 * The real constructor kicks off the initial watcher registration and wires
 * re-registration to folder changes and teardown to context subscriptions, so
 * every scenario below is driven through those public triggers.
 */
function createHandler(): HandlerFixture {
  const subscriptions: Array<{ dispose(): void }> = [];
  new SettingsViewMessageHandler({
    subscriptions,
    extensionPath: '/ext',
  } as unknown as vscode.ExtensionContext);
  return {
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
  beforeEach(() => {
    mocks.workspaceFoldersListeners.length = 0;
  });

  afterEach(() => vi.restoreAllMocks());

  it('logs and absorbs directory setup failures', async () => {
    const failure = new Error('permission denied');
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(failure);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    createHandler();

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

    // The constructor's registration pends on firstSetup; the folder-change
    // re-registration pends on secondSetup and wins the generation race.
    const fixture = createHandler();
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
    vi.spyOn(StorageFS, 'ensureDir').mockResolvedValue(undefined);
    const staleWatcher = watcher();
    const currentWatcher = watcher();
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockImplementationOnce(() => {
        // A folder change lands while the constructor's registration is
        // mid-setup: its candidate is stale the moment it returns.
        fixture.fireWorkspaceFoldersChanged();
        return staleWatcher;
      })
      .mockReturnValue(currentWatcher);
    const fixture = createHandler();

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

    fixture.disposeSubscriptions();
    setup.resolve();
    await flushRegistrations();

    expect(createWatcher).not.toHaveBeenCalled();
  });
});
