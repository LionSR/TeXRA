import { describe, expect, it, vi } from 'vitest';

import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import type { StateStore } from '@platform/interfaces';
import { FakeStateStore } from '@test/support/FakePlatform';

// The controller reads the shipped provider catalog directly, so the picker
// invalidation it triggers is the real module function; stub it here.
vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: vi.fn(),
}));

function createController(
  options: { state?: StateStore; config?: Record<string, unknown> } = {},
): SettingsProfileController {
  const config = options.config ?? {};

  return new SettingsProfileController({
    host: 'vscode',
    globalState: options.state ?? new FakeStateStore(),
    loadProviderKeyStatuses: async () => ({
      openai: 'set',
      google: 'not-set',
      openRouter: 'not-set',
    }),
    getConfig: <T>(key: string, defaultValue: T): T =>
      (Object.hasOwn(config, key) ? config[key] : defaultValue) as T,
  });
}

describe('SettingsProfileController', () => {
  it('renders declared provider setting defaults when config is unset', async () => {
    const controller = createController();

    const message = await controller.buildProfileMessage();
    const google = message.providerKeyStatuses.find(
      (status) => status.provider === 'google',
    );

    expect(google?.providerSettings).toContainEqual(
      expect.objectContaining({
        key: 'texra.model.useGoogleInteractionsServerState',
        value: true,
      }),
    );
  });
});
