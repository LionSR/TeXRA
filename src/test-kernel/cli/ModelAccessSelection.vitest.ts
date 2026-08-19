import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readCliModelAccessStatus,
  updateCliModelAccess,
} from '@cli/runtime/modelAccessSelection';
import {
  buildCliModelAccessItems,
  formatCliModelAccessRoute,
  formatCliModelAccessRouteInline,
  parseCliModelAccessSelection,
  resolveCliModelAccessRoute,
  shortCliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  getCodexStatus: vi.fn(),
  getXaiStatus: vi.fn(),
  isPreferCodexSubscription: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  isPreferXaiSubscription: vi.fn(),
  setPreferXaiSubscription: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  shouldUseSubscriptionDeviceCode: vi.fn(),
  signInCliChatGpt: vi.fn(),
  signInCliGrok: vi.fn(),
  updateGlobalState: vi.fn(),
  hasUsableApiKey: vi.fn(),
  lookupApiKeyOrigin: vi.fn(),
  getPreferKimiCode: vi.fn(),
  setPreferKimiCode: vi.fn(),
  getGLMCodingPlan: vi.fn(),
  setGLMCodingPlan: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: { update: mocks.updateGlobalState },
    secrets: {},
  }),
}));

vi.mock('@auth/codex', () => ({
  getCodexStatus: mocks.getCodexStatus,
}));

vi.mock('@auth/xai', () => ({
  getXaiStatus: mocks.getXaiStatus,
  xaiAccountLabel: (account: { email?: string } | null | undefined) =>
    account?.email ?? 'your Grok account',
}));

vi.mock('@model/codex/codexPreference', () => ({
  isPreferCodexSubscription: mocks.isPreferCodexSubscription,
  setPreferCodexSubscription: mocks.setPreferCodexSubscription,
}));

vi.mock('@model/xai/xaiPreference', () => ({
  isPreferXaiSubscription: mocks.isPreferXaiSubscription,
  setPreferXaiSubscription: mocks.setPreferXaiSubscription,
}));

vi.mock('@model/apiProviders', () => {
  const providers = [
    'openai',
    'anthropic',
    'openRouter',
    'google',
    'xai',
    'deepseek',
    'moonshot',
    'kimiCode',
    'dashscope',
    'minimax',
    'glm',
    'meta',
  ];
  return {
    API_PROVIDERS: providers,
    hasUsableApiKey: mocks.hasUsableApiKey,
    lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
    configuredApiKeyProviders: async () => {
      const origins = await Promise.all(
        providers.map((provider) => mocks.lookupApiKeyOrigin({}, provider)),
      );
      return providers.filter((_, index) => origins[index] !== 'none');
    },
  };
});

vi.mock('@utils/config/providerConfig', () => ({
  getPreferKimiCode: mocks.getPreferKimiCode,
  setPreferKimiCode: mocks.setPreferKimiCode,
  getGLMCodingPlan: mocks.getGLMCodingPlan,
  setGLMCodingPlan: mocks.setGLMCodingPlan,
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

vi.mock('@cli/runtime/chatgptLogin', () => ({
  signInCliChatGpt: mocks.signInCliChatGpt,
}));

vi.mock('@cli/runtime/grokLogin', () => ({
  signInCliGrok: mocks.signInCliGrok,
}));

vi.mock('@cli/runtime/subscriptionLogin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/subscriptionLogin')>();
  return {
    ...actual,
    shouldUseSubscriptionDeviceCode: mocks.shouldUseSubscriptionDeviceCode,
  };
});

const context = createTestCliContext();

type AccessRoute = Parameters<typeof formatCliModelAccessRoute>[0];

function subscriptionPreference(
  provider: 'chatgpt' | 'grok' | 'kimi-code' | 'glm-code',
  state: 'on' | 'off',
) {
  return { kind: 'subscription-preference', provider, state } as const;
}

function expectedAccessStatus(
  overrides: Record<string, unknown>,
  plans: {
    kimiPreferred?: boolean;
    kimiKeySet?: boolean;
    glmPreferred?: boolean;
    glmKeySet?: boolean;
  } = {},
) {
  return {
    preferences: {
      chatGpt: 'off',
      grok: 'off',
    },
    chatGptSignedIn: false,
    chatGptAccountLabel: undefined,
    grokSignedIn: false,
    grokAccountLabel: undefined,
    personalKeyProviders: [],
    ...overrides,
    codingPlans: {
      glmCodingPlan: {
        preferred: plans.glmPreferred ?? false,
        keySet: plans.glmKeySet ?? false,
      },
      kimiCode: {
        preferred: plans.kimiPreferred ?? false,
        keySet: plans.kimiKeySet ?? false,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
  mocks.getXaiStatus.mockResolvedValue({ signedIn: false });
  mocks.isPreferCodexSubscription.mockReturnValue(false);
  mocks.isPreferXaiSubscription.mockReturnValue(false);
  mocks.setPreferCodexSubscription.mockResolvedValue({
    effective: false,
    target: 'global',
  });
  mocks.setPreferXaiSubscription.mockResolvedValue({
    effective: false,
    target: 'global',
  });
  mocks.shouldUseSubscriptionDeviceCode.mockReturnValue(false);
  mocks.hasUsableApiKey.mockResolvedValue(false);
  mocks.lookupApiKeyOrigin.mockResolvedValue('none');
  mocks.getPreferKimiCode.mockReturnValue(false);
  mocks.setPreferKimiCode.mockResolvedValue(undefined);
  mocks.getGLMCodingPlan.mockReturnValue(false);
  mocks.setGLMCodingPlan.mockResolvedValue(undefined);
});

describe('CLI model access routes', () => {
  it.each([
    ['chatgpt', subscriptionPreference('chatgpt', 'on')],
    ['subscription', subscriptionPreference('chatgpt', 'on')],
    ['grok', subscriptionPreference('grok', 'on')],
    ['xai', subscriptionPreference('grok', 'on')],
    ['kimi', subscriptionPreference('kimi-code', 'on')],
    ['kimicode', subscriptionPreference('kimi-code', 'on')],
    ['kimi-code', subscriptionPreference('kimi-code', 'on')],
    ['glm', subscriptionPreference('glm-code', 'on')],
    ['glmcode', subscriptionPreference('glm-code', 'on')],
    ['glm-code', subscriptionPreference('glm-code', 'on')],
    ['glm-coding', subscriptionPreference('glm-code', 'on')],
    ['glm-coding-plan', subscriptionPreference('glm-code', 'on')],
    ['direct', undefined],
  ])('parses the route or compatibility spelling %s', (input, expected) => {
    expect(parseCliModelAccessSelection(input)).toEqual(expected);
  });

  it('uses observed access before prospective access preferences', () => {
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: true,
        usageRoute: 'relay',
      }),
    ).toBe('included');
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: true,
      }),
    ).toBe('chatgpt');
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: false,
      }),
    ).toBe('personal');
  });

  it('never relabels recorded api-key usage from live preferences', () => {
    // A completed request's route cannot change — ordinary `api-key` usage
    // stays personal even while the Kimi Code route is currently active.
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: false,
        kimiCodeActive: true,
        usageRoute: 'api-key',
      }),
    ).toBe('personal');
  });

  it('recognizes observed Kimi Code subscription usage', () => {
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: false,
        usageRoute: 'kimi-code-subscription',
      }),
    ).toBe('kimi-code');
  });

  it('describes a prospective exclusive Kimi Code route', () => {
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: false,
        kimiCodeActive: true,
      }),
    ).toBe('kimi-code');
  });

  it('reports an active GLM plan', () => {
    expect(
      resolveCliModelAccessRoute({
        subscriptionActive: false,
        glmCodingPlanActive: true,
      }),
    ).toBe('glm-code');
  });

  it('formats the shared access routes for detailed and compact surfaces', () => {
    const detailed: Array<[AccessRoute, string]> = [
      ['chatgpt', 'ChatGPT subscription'],
      ['kimi-code', 'Kimi Code subscription'],
      ['included', 'Included access'],
      ['personal', 'Your own API keys'],
    ];
    const inline: Array<[AccessRoute, string]> = [
      ['chatgpt', 'ChatGPT subscription'],
      ['kimi-code', 'Kimi Code subscription'],
      ['included', 'included access'],
      ['personal', 'your own API keys'],
    ];
    // Every arm is display text; the enum value never reaches the status bar.
    const short: Array<[AccessRoute, string]> = [
      ['chatgpt', 'subscription'],
      ['grok', 'subscription'],
      ['kimi-code', 'subscription'],
      ['included', 'Included'],
      ['personal', 'API keys'],
    ];

    for (const [route, text] of detailed) {
      expect(formatCliModelAccessRoute(route)).toBe(text);
    }
    for (const [route, text] of inline) {
      expect(formatCliModelAccessRouteInline(route)).toBe(text);
    }
    for (const [route, text] of short) {
      expect(shortCliModelAccessRoute(route)).toBe(text);
    }
  });

  it('reports the ChatGPT preference independently of sign-in', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);

    await expect(readCliModelAccessStatus()).resolves.toEqual(
      expectedAccessStatus({
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
        chatGptSignedIn: true,
        chatGptAccountLabel: 'user@example.com',
      }),
    );

    mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
    await expect(readCliModelAccessStatus()).resolves.toEqual(
      expectedAccessStatus({
        preferences: {
          chatGpt: 'on',
          grok: 'off',
        },
      }),
    );
  });

  it('reports the Kimi preference independently of key', async () => {
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider) => provider === 'kimiCode',
    );
    mocks.getPreferKimiCode.mockReturnValue(true);

    await expect(readCliModelAccessStatus()).resolves.toEqual(
      expectedAccessStatus(
        {
          preferences: {
            chatGpt: 'off',
            grok: 'off',
          },
        },
        { kimiPreferred: true, kimiKeySet: true },
      ),
    );

    mocks.hasUsableApiKey.mockResolvedValue(false);
    await expect(readCliModelAccessStatus()).resolves.toMatchObject({
      codingPlans: { kimiCode: { preferred: true, keySet: false } },
    });
  });

  it('reports configured provider keys as display names', async () => {
    mocks.lookupApiKeyOrigin.mockImplementation(async (_secrets, provider) => {
      if (provider === 'deepseek') return 'secret';
      if (provider === 'moonshot') return 'env';
      if (provider === 'kimiCode') return 'secret';
      return 'none';
    });

    await expect(readCliModelAccessStatus()).resolves.toMatchObject({
      personalKeyProviders: ['DeepSeek', 'Moonshot', 'Kimi Code'],
    });
  });

  it('enables Kimi Code routing on a personal fallback when a key exists', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);

    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('kimi-code', 'on'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(true);
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      message:
        'Prefer Kimi Code subscription enabled for Kimi models · other models still use your own API keys.',
    });
  });

  it('guides to key entry when Kimi Code is selected without a key', async () => {
    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('kimi-code', 'on'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(result.message).toContain('No Kimi Code API key configured');
    expect(result.message).toContain('https://www.kimi.com/code/console');
  });

  it('reports the GLM Coding Plan preference independently of key', async () => {
    mocks.hasUsableApiKey.mockImplementation(
      async (_secrets, provider) => provider === 'glm',
    );
    mocks.getGLMCodingPlan.mockReturnValue(true);

    await expect(readCliModelAccessStatus()).resolves.toEqual(
      expectedAccessStatus(
        {
          preferences: {
            chatGpt: 'off',
            grok: 'off',
          },
        },
        { glmPreferred: true, glmKeySet: true },
      ),
    );
  });

  it('enables GLM Coding Plan routing on a personal fallback when a key exists', async () => {
    mocks.hasUsableApiKey.mockResolvedValue(true);

    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('glm-code', 'on'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(true);
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
    expect(mocks.updateGlobalState).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      message:
        'Prefer GLM Coding Plan enabled for GLM models · other models still use your own API keys.',
    });
  });

  it('guides to key entry when GLM Coding Plan is selected without a key', async () => {
    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('glm-code', 'on'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.setGLMCodingPlan).not.toHaveBeenCalled();
    expect(result.message).toContain('No GLM API key configured');
    expect(result.message).toContain('https://open.bigmodel.cn');
  });

  it('turns off GLM Coding Plan without requiring a key', async () => {
    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('glm-code', 'off'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
    expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(false);
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      message: 'Prefer GLM Coding Plan disabled for GLM models.',
    });
  });

  it('signs in when needed and enables ChatGPT without an API key', async () => {
    mocks.signInCliChatGpt.mockResolvedValue({ email: 'user@example.com' });
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });
    const writeProgress = vi.fn();
    const controller = new AbortController();

    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('chatgpt', 'on'),
      { writeProgress, signal: controller.signal },
    );

    expect(mocks.signInCliChatGpt).toHaveBeenCalledWith(
      { device: false, noBrowser: false },
      { signal: controller.signal, writeProgress },
    );
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      'texra.useOpenRouter',
      false,
    );
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result.message).toBe(
      'Prefer ChatGPT subscription enabled for Codex models (user@example.com).',
    );
  });

  it('turns off ChatGPT without changing the Kimi preference', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: false,
      target: 'global',
    });

    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('chatgpt', 'off'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.signInCliChatGpt).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      message: 'Prefer ChatGPT subscription disabled for Codex models.',
    });
  });

  it('represents preferences independently and toggles each without side effects', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);
    mocks.getPreferKimiCode.mockReturnValue(true);
    mocks.hasUsableApiKey.mockResolvedValue(true);

    const status = await readCliModelAccessStatus();
    expect(status.preferences).toEqual({
      chatGpt: 'on',
      grok: 'off',
    });
    const descriptions = Object.fromEntries(
      buildCliModelAccessItems({ kind: 'loaded', access: status })
        .filter((item) => item.value.kind === 'subscription-preference')
        .map((item) => {
          if (item.value.kind !== 'subscription-preference') {
            throw new Error('expected subscription preference');
          }
          return [item.value.provider, item.description];
        }),
    );
    expect(descriptions).toEqual({
      chatgpt: 'On · user@example.com',
      grok: 'Off · sign in required to enable',
      'kimi-code': 'On · key configured',
      'glm-code': 'Off · key configured',
    });

    await updateCliModelAccess(
      context,
      subscriptionPreference('kimi-code', 'off'),
      { writeProgress: vi.fn() },
    );
    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(false);
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: false,
      target: 'global',
    });
    await updateCliModelAccess(
      context,
      subscriptionPreference('chatgpt', 'off'),
      { writeProgress: vi.fn() },
    );
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setPreferXaiSubscription).not.toHaveBeenCalled();
  });

  it('turns off a stale signed-out preference without signing in', async () => {
    mocks.isPreferCodexSubscription.mockReturnValue(true);
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: false,
      target: 'global',
    });

    const status = await readCliModelAccessStatus();
    const selection = buildCliModelAccessItems({
      kind: 'loaded',
      access: status,
    }).find(
      (item) =>
        item.value.kind === 'subscription-preference' &&
        item.value.provider === 'chatgpt',
    );
    expect(selection?.description).toBe('On · sign in required');
    if (!selection) throw new Error('Expected ChatGPT preference item');
    await updateCliModelAccess(context, selection.value, {
      writeProgress: vi.fn(),
    });

    expect(mocks.signInCliChatGpt).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
  });

  it('turns off a stale Kimi preference without requiring a key', async () => {
    mocks.getPreferKimiCode.mockReturnValue(true);
    const status = await readCliModelAccessStatus();
    const selection = buildCliModelAccessItems({
      kind: 'loaded',
      access: status,
    }).find(
      (item) =>
        item.value.kind === 'subscription-preference' &&
        item.value.provider === 'kimi-code',
    );
    expect(selection?.description).toBe('On · key required');
    if (!selection) throw new Error('Expected Kimi preference item');

    vi.clearAllMocks();
    await updateCliModelAccess(context, selection.value);

    expect(mocks.hasUsableApiKey).not.toHaveBeenCalled();
    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(false);
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
  });
});
