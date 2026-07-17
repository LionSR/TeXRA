// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import * as logger from '@logger/logUtils';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { StorageFS } from '@utils/files';

type WatcherHarness = {
  executionsWatcher?: vscode.FileSystemWatcher;
  executionsWatcherGeneration: number;
  invalidateExecutionsWatcher: () => number;
  registerExecutionsWatcher: () => Promise<void>;
};

function createHandlerHarness(): WatcherHarness {
  // The full constructor requires a live ExtensionContext; these methods reach
  // only the explicitly initialized watcher, generation, and logging fields.
  const handler = Object.create(SettingsViewMessageHandler.prototype);
  Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
  Reflect.set(handler, 'executionsWatcherGeneration', 0);
  return handler as WatcherHarness;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  afterEach(() => vi.restoreAllMocks());

  it('logs and absorbs directory setup failures', async () => {
    const failure = new Error('permission denied');
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(failure);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const handler = createHandlerHarness();

    await expect(handler.registerExecutionsWatcher()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      'SettingsViewMessageHandler',
      'Failed to register execution history watcher: permission denied',
    );
  });

  it('keeps the newest watcher when setup completes out of order', async () => {
    const firstSetup = deferred();
    const secondSetup = deferred();
    vi.spyOn(StorageFS, 'ensureDir')
      .mockImplementationOnce(() => firstSetup.promise)
      .mockImplementationOnce(() => secondSetup.promise);
    const currentWatcher = watcher();
    const createWatcher = vi
      .spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockReturnValue(currentWatcher);
    const handler = createHandlerHarness();

    const first = handler.registerExecutionsWatcher();
    const second = handler.registerExecutionsWatcher();
    secondSetup.resolve();
    await second;
    firstSetup.resolve();
    await first;

    expect(createWatcher).toHaveBeenCalledTimes(1);
    expect(handler.executionsWatcher).toBe(currentWatcher);
    expect(currentWatcher.dispose).not.toHaveBeenCalled();
  });

  it('disposes a candidate made stale by synchronous reentrancy', async () => {
    vi.spyOn(StorageFS, 'ensureDir').mockResolvedValue(undefined);
    const staleWatcher = watcher();
    const currentWatcher = watcher();
    const handler = createHandlerHarness();
    let second: Promise<void> | undefined;
    vi.spyOn(vscode.workspace, 'createFileSystemWatcher')
      .mockImplementationOnce(() => {
        second = handler.registerExecutionsWatcher();
        return staleWatcher;
      })
      .mockReturnValueOnce(currentWatcher);

    await handler.registerExecutionsWatcher();
    if (!second) throw new Error('reentrant registration did not start');
    await second;

    expect(staleWatcher.dispose).toHaveBeenCalledOnce();
    expect(currentWatcher.dispose).not.toHaveBeenCalled();
    expect(handler.executionsWatcher).toBe(currentWatcher);
  });

  it('invalidates setup still pending during teardown', async () => {
    const setup = deferred();
    vi.spyOn(StorageFS, 'ensureDir').mockReturnValue(setup.promise);
    const createWatcher = vi.spyOn(vscode.workspace, 'createFileSystemWatcher');
    const handler = createHandlerHarness();

    const registration = handler.registerExecutionsWatcher();
    handler.invalidateExecutionsWatcher();
    setup.resolve();
    await registration;

    expect(createWatcher).not.toHaveBeenCalled();
    expect(handler.executionsWatcher).toBeUndefined();
  });
});
