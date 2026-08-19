import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCliAuthProfile: vi.fn(),
  readCliModelAccessStatus: vi.fn(),
  lookupApiKeyOrigin: vi.fn(),
  getSubscriptionUsage: vi.fn(),
  secrets: {},
}));

vi.mock(
  '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService',
  () => ({
    SubscriptionUsageService: class {
      getUsage = mocks.getSubscriptionUsage;
    },
  }),
);

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProfile: mocks.getCliAuthProfile,
}));

vi.mock('@cli/runtime/modelAccessSelection', () => ({
  readCliModelAccessStatus: mocks.readCliModelAccessStatus,
}));

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['deepseek', 'glm', 'kimiCode'],
  lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
  configuredApiKeyProviders: async () => {
    const origins = await Promise.all(
      ['deepseek', 'glm', 'kimiCode'].map((provider) =>
        mocks.lookupApiKeyOrigin({}, provider),
      ),
    );
    return ['deepseek', 'glm', 'kimiCode'].filter(
      (_, index) => origins[index] !== 'none',
    );
  },
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ secrets: mocks.secrets }),
}));

const {
  loadCliApiStatus,
  loadCliDetailedAccountStatusLines,
  loadCliModelAccessOverview,
} = await import('@cli/runtime/apiStatus');

function lineFor(lines: readonly string[], route: string): string {
  const matches = lines.filter((line) => line.startsWith(`${route}:`));
  expect(matches).toHaveLength(1);
  return matches[0] ?? '';
}

function setPersonalKeys(...providers: string[]): void {
  mocks.lookupApiKeyOrigin.mockImplementation(
    (_secrets: unknown, provider: string) =>
      Promise.resolve(providers.includes(provider) ? 'env' : 'none'),
  );
}

function codingPlans(
  kimiPreferred = false,
  kimiKeySet = false,
  glmPreferred = false,
  glmKeySet = false,
) {
  return {
    kimiCode: { preferred: kimiPreferred, keySet: kimiKeySet },
    glmCodingPlan: { preferred: glmPreferred, keySet: glmKeySet },
  };
}

function accountStatusLines(): Promise<string[]> {
  return loadCliDetailedAccountStatusLines();
}

function renderPreferenceRoute(
  route: 'chatGpt' | 'kimiCode' | 'glmCode',
  preference: 'on' | 'off',
  enabled: boolean,
): Promise<string[]> {
  mocks.readCliModelAccessStatus.mockResolvedValue({
    preferences: {
      chatGpt: route === 'chatGpt' ? preference : 'off',
      grok: 'off',
    },
    codingPlans: codingPlans(
      route === 'kimiCode' && preference === 'on',
      route === 'kimiCode' && enabled,
      route === 'glmCode' && preference === 'on',
      route === 'glmCode' && enabled,
    ),
    chatGptSignedIn: route === 'chatGpt' && enabled,
    grokSignedIn: false,
    chatGptAccountLabel:
      route === 'chatGpt' && enabled ? 'chatgpt@example.com' : undefined,
  });
  return accountStatusLines();
}

describe('loadCliApiStatus', () => {
  beforeEach(() => {
    mocks.getCliAuthProfile.mockReset().mockResolvedValue({
      authenticated: false,
    });
    mocks.readCliModelAccessStatus.mockReset().mockResolvedValue({
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      },
      codingPlans: codingPlans(),
      chatGptSignedIn: false,
      grokSignedIn: false,
    });
    mocks.lookupApiKeyOrigin.mockReset().mockResolvedValue('none');
    mocks.getSubscriptionUsage
      .mockReset()
      .mockImplementation(async (provider: string) => ({
        state: 'unavailable',
        provider,
        providerName: provider,
        planName: provider,
        fetchedAt: 0,
        windows: [],
        reason: 'missing_credentials',
      }));
  });

  it.each([
    {
      name: 'without a profile note',
      profile: { authenticated: false },
      lines: ['api: your own API keys', 'auth: signed out'],
    },
    {
      name: 'with no profile note',
      profile: { authenticated: false },
      lines: ['api: your own API keys', 'auth: signed out'],
    },
  ])(
    'preserves signed-out launcher details $name',
    async ({ profile, lines }) => {
      mocks.getCliAuthProfile.mockResolvedValue(profile);

      await expect(loadCliApiStatus()).resolves.toEqual(lines);
    },
  );

  it('groups personal keys with their route', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
    });
    setPersonalKeys('deepseek');

    await expect(loadCliApiStatus()).resolves.toEqual([
      'api: your own API keys',
      'your own API keys: DeepSeek',
      'auth: signed in as researcher@example.com',
    ]);
  });

  it('does not couple compact launcher status to model-access reads', async () => {
    mocks.readCliModelAccessStatus.mockRejectedValue(
      new Error('preference store offline'),
    );

    await expect(loadCliApiStatus()).resolves.toEqual([
      'api: your own API keys',
      'auth: signed out',
    ]);
    expect(mocks.readCliModelAccessStatus).not.toHaveBeenCalled();
    expect(mocks.getCliAuthProfile).toHaveBeenCalledOnce();
    expect(mocks.lookupApiKeyOrigin).toHaveBeenCalledTimes(3);
  });

  it('renders preferred Kimi and ChatGPT routes with their owned credentials', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      preferences: {
        chatGpt: 'on',
        grok: 'off',
      },
      codingPlans: codingPlans(true, true),
      chatGptSignedIn: true,
      grokSignedIn: false,
      chatGptAccountLabel: 'chatgpt@example.com',
    });
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'texra@example.com',
    });
    setPersonalKeys('deepseek', 'glm', 'kimiCode');

    const lines = await accountStatusLines();
    const joined = lines.join('\n');

    expect(lineFor(lines, 'ChatGPT')).toBe(
      'ChatGPT: preferred · signed in as chatgpt@example.com',
    );
    expect(lineFor(lines, 'Kimi Code')).toBe(
      'Kimi Code: preferred · key configured',
    );
    expect(lineFor(lines, 'Otherwise')).toBe('Otherwise: Your own API keys');
    expect(lineFor(lines, 'Other API keys')).toBe(
      'Other API keys: DeepSeek, GLM',
    );
    expect(joined.match(/Kimi Code/g)).toHaveLength(1);
    expect(joined.match(/chatgpt@example\.com/g)).toHaveLength(1);
    expect(mocks.readCliModelAccessStatus).toHaveBeenCalledOnce();
    expect(mocks.getCliAuthProfile).toHaveBeenCalledOnce();
    expect(mocks.lookupApiKeyOrigin).toHaveBeenCalledTimes(3);
  });

  it('appends normalized usage to configured routes and force-refreshes on open', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      },
      codingPlans: codingPlans(true, true, true, true),
      chatGptSignedIn: false,
      grokSignedIn: false,
    });
    mocks.getSubscriptionUsage.mockImplementation(async (provider: string) => {
      if (provider === 'glmCodingPlan') {
        return {
          state: 'unavailable',
          provider,
          providerName: 'GLM',
          planName: 'GLM Coding Plan',
          fetchedAt: 1_800_000_000_000,
          windows: [],
          reason: 'request_failed',
        };
      }
      return {
        state: 'available',
        provider,
        providerName: 'Kimi Code',
        planName: 'Kimi Code',
        fetchedAt: 1_800_000_000_000,
        windows: [
          {
            name: 'five_hour',
            percentUsed: 0,
            percentRemaining: 100,
            resetAt: 1_800_007_200_000,
          },
          {
            name: 'seven_day',
            percentUsed: 100,
            percentRemaining: 0,
            resetAt: 1_800_162_000_000,
          },
        ],
      };
    });

    const lines = await loadCliDetailedAccountStatusLines({
      now: 1_800_000_000_000,
    });

    expect(lineFor(lines, 'Kimi Code')).toBe(
      'Kimi Code: preferred · key configured · 5-hour: 0% · resets in 2h · 7-day: 100% · resets in 1d 21h',
    );
    expect(lineFor(lines, 'GLM Coding Plan')).toBe(
      'GLM Coding Plan: preferred · key configured · usage unavailable',
    );
    expect(mocks.getSubscriptionUsage.mock.calls).toStrictEqual([
      ['kimiCode', { forceRefresh: true }],
      ['glmCodingPlan', { forceRefresh: true }],
    ]);
  });

  it.each([
    {
      name: 'off and signed out',
      preference: 'off',
      enabled: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off and signed in',
      preference: 'off',
      enabled: true,
      expected: [
        'ChatGPT: not preferred · signed in as chatgpt@example.com',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on and signed out',
      preference: 'on',
      enabled: false,
      expected: [
        'ChatGPT: preferred · sign in required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on and signed in',
      preference: 'on',
      enabled: true,
      expected: [
        'ChatGPT: preferred · signed in as chatgpt@example.com',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the ChatGPT route when available: $name',
    async ({ expected, enabled, preference }) => {
      await expect(
        renderPreferenceRoute('chatGpt', preference, enabled),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    {
      name: 'off without a key',
      preference: 'off',
      enabled: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off with a key',
      preference: 'off',
      enabled: true,
      expected: [
        'Kimi Code: not preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on without a key',
      preference: 'on',
      enabled: false,
      expected: [
        'Kimi Code: preferred · key required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on with a key',
      preference: 'on',
      enabled: true,
      expected: [
        'Kimi Code: preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the Kimi Code route when available: $name',
    async ({ enabled, expected, preference }) => {
      await expect(
        renderPreferenceRoute('kimiCode', preference, enabled),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    {
      name: 'off without a key',
      preference: 'off',
      enabled: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off with a key',
      preference: 'off',
      enabled: true,
      expected: [
        'GLM Coding Plan: not preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on without a key',
      preference: 'on',
      enabled: false,
      expected: [
        'GLM Coding Plan: preferred · key required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on with a key',
      preference: 'on',
      enabled: true,
      expected: [
        'GLM Coding Plan: preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the GLM Coding Plan route when available: $name',
    async ({ enabled, expected, preference }) => {
      await expect(
        renderPreferenceRoute('glmCode', preference, enabled),
      ).resolves.toEqual(expected);
    },
  );

  it('keeps a shared GLM key in the personal-key inventory', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      },
      codingPlans: codingPlans(false, false, false, true),
      chatGptSignedIn: false,
      grokSignedIn: false,
    });
    setPersonalKeys('glm');

    const lines = await accountStatusLines();

    expect(lineFor(lines, 'Other API keys')).toBe('Other API keys: GLM');
  });

  it('keeps signed-out personal-only status truthful', async () => {
    setPersonalKeys('deepseek');

    const lines = await accountStatusLines();

    expect(lines).toEqual([
      'Otherwise: Your own API keys',
      'Other API keys: DeepSeek',
    ]);
    expect(lines.join('\n')).not.toContain('TeXRA');
  });

  it('omits unavailable key categories instead of printing none', async () => {
    const lines = await accountStatusLines();

    expect(lines).toEqual(['Otherwise: Your own API keys']);
  });

  it('reports the legacy model-access overview without reading key storage', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      preferences: {
        chatGpt: 'on',
        grok: 'off',
      },
      codingPlans: codingPlans(),
      chatGptSignedIn: true,
      grokSignedIn: false,
      chatGptAccountLabel: 'chatgpt@example.com',
    });
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'texra@example.com',
    });
    mocks.lookupApiKeyOrigin.mockRejectedValue(new Error('keychain offline'));

    await expect(loadCliModelAccessOverview()).resolves.toEqual({
      access: {
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
        codingPlans: codingPlans(),
        chatGptSignedIn: true,
        grokSignedIn: false,
        chatGptAccountLabel: 'chatgpt@example.com',
      },
      lines: [
        'ChatGPT preference: On · chatgpt@example.com',
        'Grok preference: Off · sign in required to enable',
        'Kimi Code preference: Off · key required to enable',
        'GLM Coding Plan preference: Off · key required to enable',
        'Otherwise: Your own API keys',
        'Researcher Access: signed in as texra@example.com',
      ],
    });
    expect(mocks.lookupApiKeyOrigin).not.toHaveBeenCalled();
    expect(mocks.readCliModelAccessStatus).toHaveBeenCalledOnce();
    expect(mocks.getCliAuthProfile).toHaveBeenCalledOnce();
  });

  it('does not ask signed-out personal-key users to add another key', async () => {
    setPersonalKeys('deepseek');

    await expect(
      loadCliApiStatus({ includeActionHint: true }),
    ).resolves.toEqual([
      'api: your own API keys',
      'your own API keys: DeepSeek',
      'auth: signed out',
      'actions: choose Model access below; provider keys are configured',
    ]);
  });

  it('lists providers configured by secret or env origin', async () => {
    const originsByProvider: Record<string, 'secret' | 'env' | 'none'> = {
      deepseek: 'secret',
      kimiCode: 'env',
    };
    mocks.lookupApiKeyOrigin.mockImplementation(
      (_secrets: unknown, provider: string) =>
        Promise.resolve(originsByProvider[provider] ?? 'none'),
    );

    await expect(loadCliApiStatus()).resolves.toEqual([
      'api: your own API keys',
      'your own API keys: DeepSeek, Kimi Code',
      'auth: signed out',
    ]);
  });
});
