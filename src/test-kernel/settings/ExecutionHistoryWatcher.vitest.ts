// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import * as logger from '@logger/logUtils';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { StorageFS } from '@utils/files';

describe('settings execution history watcher', () => {
  it('logs and absorbs directory setup failures', async () => {
    const failure = new Error('permission denied');
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(failure);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    // The full constructor requires a live ExtensionContext; this method reaches
    // only the explicitly initialized watcher and logging fields in this path.
    const handler = Object.create(SettingsViewMessageHandler.prototype);
    Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
    const registerWatcher = Reflect.get(
      handler,
      'registerExecutionsWatcher',
    ) as () => Promise<void>;

    await expect(Reflect.apply(registerWatcher, handler, [])).resolves.toBe(
      undefined,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'SettingsViewMessageHandler',
      'Failed to register execution history watcher: permission denied',
    );
  });
});
