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
  shouldUseChatGptDeviceCode: vi.fn(),
  signInCliChatGpt: vi.fn(),
  shouldUseGrokDeviceCode: vi.fn(),
  signInCliGrok: vi.fn(),
  updateGlobalState: vi.fn(),
  apiKeyExists: vi.fn(),
  getPreferKimiCode: vi.fn(),
  setPreferKimiCode: vi.fn(),
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
  apiKeyExists: mocks.apiKeyExists,
}));

vi.mock('@utils/config/providerConfig', () => ({
  getPreferKimiCode: mocks.getPreferKimiCode,
  setPreferKimiCode: mocks.setPreferKimiCode,
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
  shouldUseChatGptDeviceCode: mocks.shouldUseChatGptDeviceCode,
  signInCliChatGpt: mocks.signInCliChatGpt,
}));

vi.mock('@cli/runtime/grokLogin', () => ({
  shouldUseGrokDeviceCode: mocks.shouldUseGrokDeviceCode,
  signInCliGrok: mocks.signInCliGrok,
}));

const context = createTestCliContext({ apiMode: 'personal' });

function subscriptionPreference(
  provider: 'chatgpt' | 'grok' | 'kimi-code',
  state: 'on' | 'off',
) {
  return { kind: 'subscription-preference', provider, state } as const;
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
  mocks.shouldUseChatGptDeviceCode.mockReturnValue(false);
  mocks.shouldUseGrokDeviceCode.mockReturnValue(false);
  mocks.apiKeyExists.mockResolvedValue(false);
  mocks.getPreferKimiCode.mockReturnValue(false);
  mocks.setPreferKimiCode.mockResolvedValue(undefined);
});

describe('CLI model access routes', () => {
  it('parses the routes and the compatibility spellings', () => {
    expect(parseCliModelAccessSelection('chatgpt')).toEqual(
      subscriptionPreference('chatgpt', 'on'),
    );
    expect(parseCliModelAccessSelection('subscription')).toEqual(
      subscriptionPreference('chatgpt', 'on'),
    );
    expect(parseCliModelAccessSelection('grok')).toEqual(
      subscriptionPreference('grok', 'on'),
    );
    expect(parseCliModelAccessSelection('xai')).toEqual(
      subscriptionPreference('grok', 'on'),
    );
    expect(parseCliModelAccessSelection('kimi')).toEqual(
      subscriptionPreference('kimi-code', 'on'),
    );
    expect(parseCliModelAccessSelection('kimicode')).toEqual(
      subscriptionPreference('kimi-code', 'on'),
    );
    expect(parseCliModelAccessSelection('kimi-code')).toEqual(
      subscriptionPreference('kimi-code', 'on'),
    );
    expect(parseCliModelAccessSelection('included')).toEqual(
      cliApiFallbackSelection('included'),
    );
    expect(parseCliModelAccessSelection('relay')).toEqual(
      cliApiFallbackSelection('included'),
    );
    expect(parseCliModelAccessSelection('personal')).toEqual(
      cliApiFallbackSelection('personal'),
    );
    expect(parseCliModelAccessSelection('byok')).toEqual(
      cliApiFallbackSelection('personal'),
    );
    expect(parseCliModelAccessSelection('direct')).toBeUndefined();
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
    expect(formatCliModelAccessRoute('chatgpt')).toBe('ChatGPT subscription');
    expect(formatCliModelAccessRoute('kimi-code')).toBe(
      'Kimi Code subscription',
    );
    expect(formatCliModelAccessRoute('included')).toBe('Included TeXRA access');
    expect(formatCliModelAccessRoute('personal')).toBe('Personal API keys');
    expect(formatCliModelAccessRouteInline('chatgpt')).toBe(
      'ChatGPT subscription',
    );
    expect(formatCliModelAccessRouteInline('kimi-code')).toBe(
      'Kimi Code subscription',
    );
    expect(formatCliModelAccessRouteInline('included')).toBe(
      'included TeXRA access',
    );
    expect(formatCliModelAccessRouteInline('personal')).toBe(
      'personal API keys',
    );
    expect(shortCliModelAccessRoute('chatgpt')).toBe('subscription');
    expect(shortCliModelAccessRoute('kimi-code')).toBe('kimi-code');
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

    await expect(readCliModelAccessStatus('included')).resolves.toEqual({
      apiFallback: 'included',
      preferences: { chatGpt: 'on', grok: 'off', kimiCode: 'off' },
      chatGptSignedIn: true,
      chatGptAccountLabel: 'user@example.com',
      grokSignedIn: false,
      grokAccountLabel: undefined,
      kimiCodeKeySet: false,
    });

    mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
    await expect(readCliModelAccessStatus('included')).resolves.toEqual({
      apiFallback: 'included',
      preferences: { chatGpt: 'on', grok: 'off', kimiCode: 'off' },
      chatGptSignedIn: false,
      chatGptAccountLabel: undefined,
      grokSignedIn: false,
      grokAccountLabel: undefined,
      kimiCodeKeySet: false,
    });
  });

  it('reports the Kimi preference independently of key and fallback', async () => {
    mocks.apiKeyExists.mockResolvedValue(true);
    mocks.getPreferKimiCode.mockReturnValue(true);

    await expect(readCliModelAccessStatus('personal')).resolves.toEqual({
      apiFallback: 'personal',
      preferences: { chatGpt: 'off', grok: 'off', kimiCode: 'on' },
      chatGptSignedIn: false,
      chatGptAccountLabel: undefined,
      grokSignedIn: false,
      grokAccountLabel: undefined,
      kimiCodeKeySet: true,
    });

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

  it('enables Kimi Code routing on a personal fallback when a key exists', async () => {
    mocks.apiKeyExists.mockResolvedValue(true);

    const result = await updateCliModelAccess(
      context,
      subscriptionPreference('kimi-code', 'on'),
      { writeProgress: vi.fn() },
    );

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(true);
    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      'texra.useOpenRouter',
      false,
    );
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      apiMode: 'personal',
      message:
        'Prefer Kimi Code subscription enabled for Kimi models · API fallback remains Personal API keys.',
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
      message: 'API fallback: Personal API keys.',
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
    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(false);
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
  });
});
