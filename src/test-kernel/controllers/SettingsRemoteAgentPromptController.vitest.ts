import { strict as assert } from 'node:assert';

import { describe, it, vi } from 'vitest';

import { FREE_TIER, ULTRA_TIER, type UserTier } from '@auth/config';
import { SettingsRemoteAgentPromptController } from '@controllers/settingsView/SettingsRemoteAgentPromptController';

function createController(options: {
  tier: UserTier;
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
      getUserTier: async () => options.tier,
      getAccessToken: async () => options.token,
      fetchPromptConfig,
    }),
    fetchPromptConfig,
  };
}

describe('SettingsRemoteAgentPromptController', () => {
  it('rejects non-Ultra users before requesting a token', async () => {
    const { controller, fetchPromptConfig } = createController({
      tier: FREE_TIER,
      token: 'token',
    });

    const result = await controller.getPromptConfig('remoteWriter');

    assert.deepEqual(result, {
      ok: false,
      message: 'Viewing remote agent prompts requires an Ultra plan.',
    });
    assert.equal(fetchPromptConfig.mock.calls.length, 0);
  });

  it('rejects Ultra users without an access token', async () => {
    const { controller, fetchPromptConfig } = createController({
      tier: ULTRA_TIER,
      token: null,
    });

    const result = await controller.getPromptConfig('remoteWriter');

    assert.deepEqual(result, {
      ok: false,
      message: 'Authentication required. Sign in using "TeXRA: Sign In".',
    });
    assert.equal(fetchPromptConfig.mock.calls.length, 0);
  });

  it('fetches the remote prompt config for authenticated Ultra users', async () => {
    const { controller, fetchPromptConfig } = createController({
      tier: ULTRA_TIER,
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
