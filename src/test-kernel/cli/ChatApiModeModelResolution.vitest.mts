import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveChatRootModelForApiMode } from '@cli/chat/tui/runChatTui';
import { computeModelOptionsData } from '@model/computeModelOptions';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
}));

vi.mock('@model/computeModelOptions', () => ({
  computeModelOptionsData: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
  signInCliSupabase: vi.fn(),
  signOutCliSupabase: vi.fn(),
}));

const computeModelOptionsDataMock = vi.mocked(computeModelOptionsData);

describe('CLI chat API-mode model resolution', () => {
  beforeEach(() => {
    computeModelOptionsDataMock.mockReset();
    mocks.authProvider.isAuthenticated.mockReset();
  });

  it('keeps a personal-key model in personal API mode', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      {
        value: 'gpt55',
        label: 'GPT-5.5',
        availability: 'provider-key',
        availabilityLabel: 'API key set',
      },
    ]);

    await expect(
      resolveChatRootModelForApiMode('gpt55', 'personal', 'reject'),
    ).resolves.toEqual({ model: 'gpt55' });
  });

  it('rejects a personal-key model after switching to signed-out relay mode', async () => {
    computeModelOptionsDataMock.mockResolvedValueOnce([
      {
        value: 'gpt55',
        label: 'GPT-5.5',
        availability: 'provider-key',
        availabilityLabel: 'API key set',
      },
    ]);
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(false);

    await expect(
      resolveChatRootModelForApiMode('gpt55', 'included', 'reject'),
    ).rejects.toThrow(
      'Run `texra login` for included relay access, or switch to personal API keys with `/api personal` after configuring a provider API key.',
    );
  });
});
