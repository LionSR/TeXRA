import { strict as assert } from 'node:assert';

import { describe, it, vi } from 'vitest';

import { SettingsRemoteAgentPromptController } from '@controllers/settingsView/SettingsRemoteAgentPromptController';

function createController(options: {
  token: string | null;
  fetchPromptConfig?: (
    agentName: string,
    accessToken: string,
  ) => Promise<string>;
}): {
  controller: SettingsRemoteAgentPromptController;
  fetchPromptConfig: ReturnType<typeof vi.fn>;
} {
  const fetchPromptConfig = vi.fn(
    options.fetchPromptConfig ??
      (async () => 'settings:\n  model: test\nprompts: {}\n'),
  );
  return {
    controller: new SettingsRemoteAgentPromptController({
      getAccessToken: async () => options.token,
      fetchPromptConfig,
    }),
    fetchPromptConfig,
  };
}

describe('SettingsRemoteAgentPromptController', () => {
  it('rejects users without an access token', async () => {
    const { controller, fetchPromptConfig } = createController({
      token: null,
    });

    const result = await controller.getPromptConfig('remoteWriter');

    assert.deepEqual(result, {
      ok: false,
      message: 'Authentication required. Sign in using "TeXRA: Sign In".',
    });
    assert.equal(fetchPromptConfig.mock.calls.length, 0);
  });

  it('fetches the remote prompt config for any signed-in user', async () => {
    const { controller, fetchPromptConfig } = createController({
      token: 'access-token',
    });

    const result = await controller.getPromptConfig('remoteWriter');

    assert.deepEqual(result, {
      ok: true,
      config: 'settings:\n  model: test\nprompts: {}\n',
    });
    assert.deepEqual(fetchPromptConfig.mock.calls, [
      ['remoteWriter', 'access-token'],
    ]);
  });
});
