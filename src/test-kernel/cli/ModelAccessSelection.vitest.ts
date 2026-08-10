import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  contextForCliModelAccess,
  readCliModelAccessStatus,
  updateCliModelAccess,
} from '@cli/runtime/modelAccessSelection';
import {
  buildCliModelAccessItems,
  cliApiFallbackSelection,
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
  setCliApiMode: vi.fn(),
  shouldUseSubscriptionDeviceCode: vi.fn(),
  signInCliChatGpt: vi.fn(),
  signInCliGrok: vi.fn(),
  updateGlobalState: vi.fn(),
  apiKeyExists: vi.fn(),
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

vi.mock('@model/apiProviders', () => ({
  API_PROVIDERS: [
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
  ],
  apiKeyExists: mocks.apiKeyExists,
  lookupApiKeyOrigin: mocks.lookupApiKeyOrigin,
  configuredApiKeyProviders: async () => {
    const origins = await Promise.all(
      [
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
      ].map((provider) => mocks.lookupApiKeyOrigin({}, provider)),
    );
    return [
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
    ].filter((_, index) => origins[index] !== 'none');
  },
}));

vi.mock('@utils/config/providerConfig', () => ({
  getPreferKimiCode: mocks.getPreferKimiCode,
  setPreferKimiCode: mocks.setPreferKimiCode,
  getGLMCodingPlan: mocks.getGLMCodingPlan,
  setGLMCodingPlan: mocks.setGLMCodingPlan,
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

vi.mock('@cli/runtime/apiAccessMode', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/apiAccessMode')>();
  return {
    ...actual,
    effectiveCliApiMode: (source: { apiMode?: 'included' | 'personal' }) =>
      source.apiMode ?? 'included',
    setCliApiMode: mocks.setCliApiMode,
  };
});

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

const context = createTestCliContext({ apiMode: 'personal' });

type AccessRoute = Parameters<typeof formatCliModelAccessRoute>[0];

function subscriptionPreference(
  provider: 'chatgpt' | 'grok' | 'kimi-code' | 'glm-code',
  state: 'on' | 'off',
) {
  return { kind: 'subscription-preference', provider, state } as const;
}

function expectedAccessStatus(overrides: Record<string, unknown>) {
  return {
    preferences: {
      chatGpt: 'off',
      grok: 'off',
      kimiCode: 'off',
      glmCode: 'off',
    },
    chatGptSignedIn: false,
    chatGptAccountLabel: undefined,
    grokSignedIn: false,
    grokAccountLabel: undefined,
    kimiCodeKeySet: false,
    glmKeySet: false,
    personalKeyProviders: [],
    ...overrides,
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
  mocks.setCliApiMode.mockImplementation(async (mode: string) => ({
    mode,
    openRouterDisabled: false,
  }));
  mocks.shouldUseSubscriptionDeviceCode.mockReturnValue(false);
  mocks.apiKeyExists.mockResolvedValue(false);
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
    ['included', cliApiFallbackSelection('included')],
    ['relay', cliApiFallbackSelection('included')],
    ['personal', cliApiFallbackSelection('personal')],
    ['byok', cliApiFallbackSelection('personal')],
    ['direct', undefined],
  ])('parses the route or compatibility spelling %s', (input, expected) => {
    expect(parseCliModelAccessSelection(input)).toEqual(expected);
  });

  it('keeps canonical API fallback selections stable and immutable', () => {
    const included = cliApiFallbackSelection('included');
    const personal = cliApiFallbackSelection('personal');

    expect(cliApiFallbackSelection('included')).toBe(included);
    expect(cliApiFallbackSelection('personal')).toBe(personal);
    expect(Object.isFrozen(included)).toBe(true);
    expect(Object.isFrozen(personal)).toBe(true);
  });

  it('uses observed access before prospective access preferences', () => {
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: true,
        usageRoute: 'relay',
      }),
    ).toBe('included');
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'included',
        subscriptionActive: true,
      }),
    ).toBe('chatgpt');
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
      }),
    ).toBe('personal');
  });

  it('never relabels recorded api-key usage from live preferences', () => {
    // A completed request's route cannot change — ordinary `api-key` usage
    // stays personal even while the Kimi Code route is currently active.
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
        kimiCodeActive: true,
        usageRoute: 'api-key',
      }),
    ).toBe('personal');
  });

  it('recognizes observed Kimi Code subscription usage', () => {
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
        usageRoute: 'kimi-code-subscription',
      }),
    ).toBe('kimi-code');
  });

  it('describes a prospective Kimi Code route only for personal access', () => {
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
        kimiCodeActive: true,
      }),
    ).toBe('kimi-code');
    // Under included access the relay owns eligible models.
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'included',
        subscriptionActive: false,
        kimiCodeActive: true,
      }),
    ).toBe('included');
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

  it('applies a launcher access choice to the launched session', () => {
    const explicitIncluded = { ...context, apiMode: 'included' as const };

    expect(contextForCliModelAccess(explicitIncluded, 'personal')).toEqual({
      ...explicitIncluded,
      apiMode: 'personal',
    });
    expect(contextForCliModelAccess(explicitIncluded, undefined)).toBe(
      explicitIncluded,
    );
  });

  it('reports the ChatGPT preference independently of sign-in', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);

    await expect(readCliModelAccessStatus('included')).resolves.toEqual(
      expectedAccessStatus({
        apiFallback: 'included',
        preferences: {
          chatGpt: 'on',
          grok: 'off',
          kimiCode: 'off',
          glmCode: 'off',
        },
        chatGptSignedIn: true,
        chatGptAccountLabel: 'user@example.com',
      }),
    );

    mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
    await expect(readCliModelAccessStatus('included')).resolves.toEqual(
      expectedAccessStatus({
        apiFallback: 'included',
        preferences: {
          chatGpt: 'on',
          grok: 'off',
          kimiCode: 'off',
          glmCode: 'off',
        },
      }),
    );
  });

  it('reports the Kimi preference independently of key and fallback', async () => {
    mocks.apiKeyExists.mockImplementation(
      async (_secrets, provider) => provider === 'kimiCode',
    );
    mocks.getPreferKimiCode.mockReturnValue(true);

    await expect(readCliModelAccessStatus('personal')).resolves.toEqual(
      expectedAccessStatus({
        apiFallback: 'personal',
        preferences: {
          chatGpt: 'off',
          grok: 'off',
          kimiCode: 'on',
          glmCode: 'off',
        },
        kimiCodeKeySet: true,
      }),
    );

    await expect(readCliModelAccessStatus('included')).resolves.toMatchObject({
      apiFallback: 'included',
      preferences: { chatGpt: 'off', grok: 'off', kimiCode: 'on' },
      kimiCodeKeySet: true,
    });

    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(readCliModelAccessStatus('personal')).resolves.toMatchObject({
      apiFallback: 'personal',
      preferences: { chatGpt: 'off', grok: 'off', kimiCode: 'on' },
      kimiCodeKeySet: false,
    });
  });

  it('reports configured provider keys as display names', async () => {
    mocks.lookupApiKeyOrigin.mockImplementation(async (_secrets, provider) => {
      if (provider === 'deepseek') return 'secret';
      if (provider === 'moonshot') return 'env';
      if (provider === 'kimiCode') return 'secret';
      return 'none';
    });

    await expect(readCliModelAccessStatus('personal')).resolves.toMatchObject({
      apiFallback: 'personal',
      personalKeyProviders: ['DeepSeek', 'Moonshot', 'Kimi Code'],
    });
  });

  it('renders configured provider keys in the personal item description', async () => {
    mocks.lookupApiKeyOrigin.mockImplementation(async (_secrets, provider) => {
      if (provider === 'deepseek') return 'secret';
      if (provider === 'moonshot') return 'env';
      if (provider === 'kimiCode') return 'secret';
      return 'none';
    });
    const status = await readCliModelAccessStatus('personal');

    const items = buildCliModelAccessItems({ kind: 'loaded', access: status });
    const personalItem = items.find(
      (item) =>
        item.value.kind === 'api-fallback' && item.value.apiMode === 'personal',
    );
    expect(personalItem?.description).toBe(
      'Configured: DeepSeek, Moonshot, Kimi Code',
    );
  });

  it('enables Kimi Code routing on a personal fallback when a key exists', async () => {
    mocks.apiKeyExists.mockResolvedValue(true);

    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('kimi-code', 'on'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      'texra.kimiCode.prefer',
      true,
    );
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      'texra.useOpenRouter',
      false,
    );
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      apiMode: 'personal',
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
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(result.apiMode).toBe('personal');
    expect(result.message).toContain('No Kimi Code API key configured');
    expect(result.message).toContain('https://www.kimi.com/code/console');
  });

  it('reports the GLM Coding Plan preference independently of key and fallback', async () => {
    mocks.apiKeyExists.mockImplementation(
      async (_secrets, provider) => provider === 'glm',
    );
    mocks.getGLMCodingPlan.mockReturnValue(true);

    await expect(readCliModelAccessStatus('personal')).resolves.toEqual(
      expectedAccessStatus({
        apiFallback: 'personal',
        preferences: {
          chatGpt: 'off',
          grok: 'off',
          kimiCode: 'off',
          glmCode: 'on',
        },
        glmKeySet: true,
      }),
    );

    await expect(readCliModelAccessStatus('included')).resolves.toMatchObject({
      apiFallback: 'included',
      preferences: {
        chatGpt: 'off',
        grok: 'off',
        kimiCode: 'off',
        glmCode: 'on',
      },
      glmKeySet: true,
    });
  });

  it('enables GLM Coding Plan routing on a personal fallback when a key exists', async () => {
    mocks.apiKeyExists.mockResolvedValue(true);

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
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      apiMode: 'personal',
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
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(result.apiMode).toBe('personal');
    expect(result.message).toContain('No GLM API key configured');
    expect(result.message).toContain('https://open.bigmodel.cn');
  });

  it('turns off GLM Coding Plan without requiring a key', async () => {
    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('glm-code', 'off'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.apiKeyExists).not.toHaveBeenCalled();
    expect(mocks.setGLMCodingPlan).toHaveBeenCalledWith(false);
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      apiMode: 'personal',
      message: 'Prefer GLM Coding Plan disabled for GLM models.',
    });
  });

  it('switches API-based routes through one policy boundary', async () => {
    const result = await updateCliModelAccess(
      context,
      cliApiFallbackSelection('personal'),
    );

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(result).toEqual({
      apiMode: 'personal',
      message: 'Now using your own API keys.',
    });
  });

  it('preserves both enabled preferences while changing the API fallback', async () => {
    await updateCliModelAccess(context, cliApiFallbackSelection('included'));

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('included');
  });

  it('announces the OpenRouter routing that included access turned off', async () => {
    mocks.setCliApiMode.mockResolvedValue({
      mode: 'included',
      openRouterDisabled: true,
    });

    const result = await updateCliModelAccess(
      context,
      cliApiFallbackSelection('included'),
    );

    expect(result.message).toContain('OpenRouter has been turned off');
  });

  it('does not report an API route as selected when persistence fails', async () => {
    mocks.setCliApiMode.mockRejectedValue(new Error('Config write failed'));

    await expect(
      updateCliModelAccess(context, cliApiFallbackSelection('included')),
    ).rejects.toThrow('Config write failed');
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
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
    expect(result.apiMode).toBe('personal');
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
      apiMode: 'personal',
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
    mocks.apiKeyExists.mockResolvedValue(true);

    const status = await readCliModelAccessStatus('personal');
    expect(status.preferences).toEqual({
      chatGpt: 'on',
      grok: 'off',
      kimiCode: 'on',
      glmCode: 'off',
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
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      'texra.kimiCode.prefer',
      false,
    );
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

    const status = await readCliModelAccessStatus('personal');
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
    const status = await readCliModelAccessStatus('personal');
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

    expect(mocks.apiKeyExists).not.toHaveBeenCalled();
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      'texra.kimiCode.prefer',
      false,
    );
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
  });
});
