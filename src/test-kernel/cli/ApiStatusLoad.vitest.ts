import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchRelayUsageSummary: vi.fn(),
  getCliApiMode: vi.fn(),
  getCliAuthProfile: vi.fn(),
  getCliSessionAccessToken: vi.fn(),
  readCliModelAccessStatus: vi.fn(),
  resolveCliUsageTier: vi.fn(),
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

vi.mock('@cli/runtime/apiAccessMode', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    getCliApiMode: mocks.getCliApiMode,
  };
});

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProfile: mocks.getCliAuthProfile,
  getCliSessionAccessToken: mocks.getCliSessionAccessToken,
  resolveCliUsageTier: mocks.resolveCliUsageTier,
}));

vi.mock('@cli/runtime/relayUsage', () => ({
  fetchRelayUsageSummary: mocks.fetchRelayUsageSummary,
}));

vi.mock('@cli/runtime/modelAccessSelection', () => ({
  readCliModelAccessStatus: mocks.readCliModelAccessStatus,
}));

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: ['deepseek', 'kimiCode'],
  lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
  configuredApiKeyProviders: async () => {
    const origins = await Promise.all(
      ['deepseek', 'kimiCode'].map((provider) =>
        mocks.lookupApiKeyOrigin({}, provider),
      ),
    );
    return ['deepseek', 'kimiCode'].filter(
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

/** Model-access status with the included fallback and every route off. */
function useIncludedAccessStatus(): void {
  mocks.readCliModelAccessStatus.mockResolvedValue({
    apiFallback: 'included',
    preferences: {
      chatGpt: 'off',
      grok: 'off',
      kimiCode: 'off',
      glmCode: 'off',
    },
    chatGptSignedIn: false,
    grokSignedIn: false,
    kimiCodeKeySet: false,
    glmKeySet: false,
  });
}

function accountStatusLines(
  apiMode: 'personal' | 'included',
): Promise<string[]> {
  return loadCliDetailedAccountStatusLines({ apiMode });
}

describe('loadCliApiStatus', () => {
  beforeEach(() => {
    mocks.fetchRelayUsageSummary.mockReset();
    mocks.getCliApiMode.mockReset().mockReturnValue('personal');
    mocks.getCliAuthProfile.mockReset().mockResolvedValue({
      authenticated: false,
    });
    mocks.getCliSessionAccessToken
      .mockReset()
      .mockResolvedValue('session-token');
    mocks.resolveCliUsageTier.mockReset().mockResolvedValue('free');
    mocks.readCliModelAccessStatus.mockReset().mockResolvedValue({
      apiFallback: 'personal',
      preferences: {
        chatGpt: 'off',
        grok: 'off',
        kimiCode: 'off',
        glmCode: 'off',
      },
      chatGptSignedIn: false,
      grokSignedIn: false,
      kimiCodeKeySet: false,
      glmKeySet: false,
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
      name: 'with a profile note',
      profile: {
        authenticated: false,
        note: 'The configured relay token was rejected.',
      },
      lines: [
        'api: your own API keys',
        'auth: signed out',
        'The configured relay token was rejected.',
      ],
    },
  ])(
    'preserves signed-out launcher details $name',
    async ({ profile, lines }) => {
      mocks.getCliAuthProfile.mockResolvedValue(profile);

      await expect(loadCliApiStatus()).resolves.toEqual(lines);
    },
  );

  it('uses an invocation API mode override for launcher status text', async () => {
    await expect(
      loadCliApiStatus({
        apiMode: 'included',
        includeActionHint: true,
      }),
    ).resolves.toEqual([
      'api: included access',
      'auth: signed out',
      'actions: choose Model access below; `texra login` signs in with Researcher Access',
    ]);
    expect(mocks.getCliApiMode).not.toHaveBeenCalled();
  });

  it('keeps launcher usage compact', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
      tier: 'Ultra',
      credentialSource: 'session',
    });
    mocks.resolveCliUsageTier.mockResolvedValue('Ultra');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 100.3 });

    await expect(loadCliApiStatus({ apiMode: 'included' })).resolves.toEqual([
      'api: included access',
      'auth: signed in as researcher@example.com · tier: Ultra · included usage this month: 100.3% used, 0% remaining',
    ]);
  });

  it('groups personal keys with their route and omits unused included quota', async () => {
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'researcher@example.com',
      tier: 'Researcher',
      credentialSource: 'session',
      note: 'Account metadata may be stale.',
    });
    setPersonalKeys('deepseek');
    mocks.resolveCliUsageTier.mockResolvedValue('Researcher');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 25 });

    await expect(loadCliApiStatus()).resolves.toEqual([
      'api: your own API keys',
      'your own API keys: DeepSeek',
      'auth: signed in as researcher@example.com · tier: Researcher',
      'Account metadata may be stale.',
    ]);
    expect(mocks.fetchRelayUsageSummary).not.toHaveBeenCalled();
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
    expect(mocks.lookupApiKeyOrigin).toHaveBeenCalledTimes(2);
  });

  it('renders preferred Kimi and ChatGPT routes with their owned credentials', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      apiFallback: 'included',
      preferences: {
        chatGpt: 'on',
        grok: 'off',
        kimiCode: 'on',
        glmCode: 'off',
      },
      chatGptSignedIn: true,
      grokSignedIn: false,
      chatGptAccountLabel: 'chatgpt@example.com',
      kimiCodeKeySet: true,
      glmKeySet: false,
    });
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'texra@example.com',
      tier: 'Ultra',
      credentialSource: 'session',
    });
    setPersonalKeys('deepseek', 'kimiCode');
    mocks.resolveCliUsageTier.mockResolvedValue('Ultra');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 24.5 });

    const lines = await accountStatusLines('included');

    expect(lineFor(lines, 'ChatGPT')).toBe(
      'ChatGPT: preferred · signed in as chatgpt@example.com',
    );
    expect(lineFor(lines, 'Kimi Code')).toBe(
      'Kimi Code: preferred · key configured',
    );
    expect(lineFor(lines, 'Otherwise')).toBe(
      'Otherwise: Included access · signed in as texra@example.com · Ultra · included usage this month: 24.5% used, 75.5% remaining',
    );
    expect(lineFor(lines, 'Other API keys')).toBe('Other API keys: DeepSeek');
    expect(lines.join('\n').match(/Kimi Code/g)).toHaveLength(1);
    expect(lines.join('\n').match(/chatgpt@example\.com/g)).toHaveLength(1);
    expect(lines.join('\n').match(/texra@example\.com/g)).toHaveLength(1);
    expect(mocks.readCliModelAccessStatus).toHaveBeenCalledOnce();
    expect(mocks.getCliAuthProfile).toHaveBeenCalledOnce();
    expect(mocks.lookupApiKeyOrigin).toHaveBeenCalledTimes(2);
  });

  it('appends normalized usage to configured routes and force-refreshes on open', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      apiFallback: 'personal',
      preferences: {
        chatGpt: 'off',
        grok: 'off',
        kimiCode: 'on',
        glmCode: 'on',
      },
      chatGptSignedIn: false,
      grokSignedIn: false,
      kimiCodeKeySet: true,
      glmKeySet: true,
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
      apiMode: 'personal',
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
      signedIn: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off and signed in',
      preference: 'off',
      signedIn: true,
      expected: [
        'ChatGPT: not preferred · signed in as chatgpt@example.com',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on and signed out',
      preference: 'on',
      signedIn: false,
      expected: [
        'ChatGPT: preferred · sign in required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on and signed in',
      preference: 'on',
      signedIn: true,
      expected: [
        'ChatGPT: preferred · signed in as chatgpt@example.com',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the ChatGPT route when available: $name',
    async ({ expected, preference, signedIn }) => {
      mocks.readCliModelAccessStatus.mockResolvedValue({
        apiFallback: 'personal',
        preferences: {
          chatGpt: preference,
          grok: 'off',
          kimiCode: 'off',
          glmCode: 'off',
        },
        chatGptSignedIn: signedIn,
        chatGptAccountLabel: signedIn ? 'chatgpt@example.com' : undefined,
        kimiCodeKeySet: false,
        glmKeySet: false,
      });

      await expect(accountStatusLines('personal')).resolves.toEqual(expected);
    },
  );

  it.each([
    {
      name: 'off without a key',
      preference: 'off',
      keySet: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off with a key',
      preference: 'off',
      keySet: true,
      expected: [
        'Kimi Code: not preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on without a key',
      preference: 'on',
      keySet: false,
      expected: [
        'Kimi Code: preferred · key required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on with a key',
      preference: 'on',
      keySet: true,
      expected: [
        'Kimi Code: preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the Kimi Code route when available: $name',
    async ({ expected, keySet, preference }) => {
      mocks.readCliModelAccessStatus.mockResolvedValue({
        apiFallback: 'personal',
        preferences: {
          chatGpt: 'off',
          grok: 'off',
          kimiCode: preference,
          glmCode: 'off',
        },
        chatGptSignedIn: false,
        grokSignedIn: false,
        kimiCodeKeySet: keySet,
        glmKeySet: false,
      });

      await expect(accountStatusLines('personal')).resolves.toEqual(expected);
    },
  );

  it.each([
    {
      name: 'off without a key',
      preference: 'off',
      keySet: false,
      expected: ['Otherwise: Your own API keys'],
    },
    {
      name: 'off with a key',
      preference: 'off',
      keySet: true,
      expected: [
        'GLM Coding Plan: not preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on without a key',
      preference: 'on',
      keySet: false,
      expected: [
        'GLM Coding Plan: preferred · key required',
        'Otherwise: Your own API keys',
      ],
    },
    {
      name: 'on with a key',
      preference: 'on',
      keySet: true,
      expected: [
        'GLM Coding Plan: preferred · key configured',
        'Otherwise: Your own API keys',
      ],
    },
  ] as const)(
    'renders the GLM Coding Plan route when available: $name',
    async ({ expected, keySet, preference }) => {
      mocks.readCliModelAccessStatus.mockResolvedValue({
        apiFallback: 'personal',
        preferences: {
          chatGpt: 'off',
          grok: 'off',
          kimiCode: 'off',
          glmCode: preference,
        },
        chatGptSignedIn: false,
        grokSignedIn: false,
        kimiCodeKeySet: false,
        glmKeySet: keySet,
      });

      await expect(accountStatusLines('personal')).resolves.toEqual(expected);
    },
  );

  it('keeps signed-out personal-only status truthful', async () => {
    setPersonalKeys('deepseek');

    const lines = await accountStatusLines('personal');

    expect(lines).toEqual([
      'Otherwise: Your own API keys',
      'Other API keys: DeepSeek',
    ]);
    expect(lines.join('\n')).not.toContain('TeXRA');
  });

  it('keeps signed-out included-only status truthful and omits empty keys', async () => {
    useIncludedAccessStatus();

    const lines = await accountStatusLines('included');

    expect(lines).toEqual(['Otherwise: Included access · signed out']);
    expect(mocks.fetchRelayUsageSummary).not.toHaveBeenCalled();
  });

  it('keeps included-only account, tier, and usage on the fallback route', async () => {
    useIncludedAccessStatus();
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'included@example.com',
      tier: 'Researcher',
      credentialSource: 'session',
    });
    mocks.resolveCliUsageTier.mockResolvedValue('Researcher');
    mocks.fetchRelayUsageSummary.mockResolvedValue({ usagePercent: 10 });

    const lines = await accountStatusLines('included');

    expect(lines).toEqual([
      'Otherwise: Included access · signed in as included@example.com · Researcher · included usage this month: 10.0% used, 90.0% remaining',
    ]);
  });

  it('owns the CI-token limitation on the included fallback', async () => {
    useIncludedAccessStatus();
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'CI token (TEXRA_RELAY_TOKEN)',
      tier: 'Researcher',
      credentialSource: 'relayToken',
    });
    mocks.getCliSessionAccessToken.mockResolvedValue(null);

    const lines = await accountStatusLines('included');
    const fallback = lineFor(lines, 'Otherwise');

    expect(fallback).toContain('CI token (TEXRA_RELAY_TOKEN)');
    expect(fallback).toContain('Researcher');
    expect(fallback).toContain('TEXRA_RELAY_TOKEN on its own cannot read it');
    expect(lines.filter((line) => line.includes('CI token'))).toHaveLength(1);
    expect(mocks.fetchRelayUsageSummary).not.toHaveBeenCalled();
  });

  it('owns usage-fetch failures on the included fallback', async () => {
    useIncludedAccessStatus();
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'texra@example.com',
      tier: 'Ultra',
      credentialSource: 'session',
    });
    mocks.resolveCliUsageTier.mockResolvedValue('Ultra');
    mocks.fetchRelayUsageSummary.mockRejectedValue(new Error('quota offline'));

    const lines = await accountStatusLines('included');

    expect(lineFor(lines, 'Otherwise')).toContain(
      'Ultra · included usage: quota offline',
    );
    expect(lines.filter((line) => line.includes('quota offline'))).toHaveLength(
      1,
    );
  });

  it('omits unavailable key categories instead of printing none', async () => {
    const lines = await accountStatusLines('personal');

    expect(lines).toEqual(['Otherwise: Your own API keys']);
  });

  it('preserves a profile note exactly once', async () => {
    const profileNote = 'Account metadata may be stale.';
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: false,
      note: profileNote,
    });

    const lines = await accountStatusLines('personal');

    expect(lines.filter((line) => line === profileNote)).toHaveLength(1);
  });

  it('reports the legacy model-access overview without reading key storage', async () => {
    mocks.readCliModelAccessStatus.mockResolvedValue({
      apiFallback: 'personal',
      preferences: {
        chatGpt: 'on',
        grok: 'off',
        kimiCode: 'off',
        glmCode: 'off',
      },
      chatGptSignedIn: true,
      grokSignedIn: false,
      chatGptAccountLabel: 'chatgpt@example.com',
      kimiCodeKeySet: false,
      glmKeySet: false,
    });
    mocks.getCliAuthProfile.mockResolvedValue({
      authenticated: true,
      accountLabel: 'texra@example.com',
    });
    mocks.lookupApiKeyOrigin.mockRejectedValue(new Error('keychain offline'));

    await expect(
      loadCliModelAccessOverview({ apiMode: 'personal' }),
    ).resolves.toEqual({
      access: {
        apiFallback: 'personal',
        preferences: {
          chatGpt: 'on',
          grok: 'off',
          kimiCode: 'off',
          glmCode: 'off',
        },
        chatGptSignedIn: true,
        grokSignedIn: false,
        chatGptAccountLabel: 'chatgpt@example.com',
        kimiCodeKeySet: false,
        glmKeySet: false,
        texraSignedIn: true,
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
