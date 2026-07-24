import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  contextForCliModelAccess,
  readCliModelAccessStatus,
  selectCliApiModelAccessRoute,
  selectCliModelAccessRoute,
} from '@cli/runtime/modelAccessSelection';
import {
  formatCliModelAccessRoute,
  formatCliModelAccessRouteInline,
  parseCliModelAccessRoute,
  resolveCliModelAccessRoute,
  shortCliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  getChatGptAuthStatus: vi.fn(),
  getCodexStatus: vi.fn(),
  isPreferCodexSubscription: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  setCliApiMode: vi.fn(),
  shouldUseChatGptDeviceCode: vi.fn(),
  signInCliChatGpt: vi.fn(),
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
  getChatGptAuthStatus: mocks.getChatGptAuthStatus,
  getCodexStatus: mocks.getCodexStatus,
  isPreferCodexSubscription: mocks.isPreferCodexSubscription,
  setPreferCodexSubscription: mocks.setPreferCodexSubscription,
}));

vi.mock('@model/apiProviders', () => ({
  PERSONAL_API_KEY_PROVIDERS: ['openai'],
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
  chatGptAccountLabel: (session: { email?: string }) =>
    session.email ?? 'your ChatGPT account',
  shouldUseChatGptDeviceCode: mocks.shouldUseChatGptDeviceCode,
  signInCliChatGpt: mocks.signInCliChatGpt,
}));

const context = createTestCliContext({ apiMode: 'personal' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
  mocks.getChatGptAuthStatus.mockResolvedValue({
    signedIn: false,
    email: null,
    accountId: null,
    preferSubscription: false,
    subscriptionToolUseOnly: false,
  });
  mocks.isPreferCodexSubscription.mockReturnValue(false);
  mocks.setPreferCodexSubscription.mockResolvedValue({
    effective: false,
    target: 'global',
  });
  mocks.setCliApiMode.mockResolvedValue(undefined);
  mocks.shouldUseChatGptDeviceCode.mockReturnValue(false);
  mocks.apiKeyExists.mockResolvedValue(false);
  mocks.getPreferKimiCode.mockReturnValue(false);
  mocks.setPreferKimiCode.mockResolvedValue(undefined);
});

describe('CLI model access routes', () => {
  it('parses the routes and the compatibility spellings', () => {
    expect(parseCliModelAccessRoute('chatgpt')).toBe('chatgpt');
    expect(parseCliModelAccessRoute('subscription')).toBe('chatgpt');
    expect(parseCliModelAccessRoute('kimi')).toBe('kimi-code');
    expect(parseCliModelAccessRoute('kimicode')).toBe('kimi-code');
    expect(parseCliModelAccessRoute('kimi-code')).toBe('kimi-code');
    expect(parseCliModelAccessRoute('included')).toBe('included');
    expect(parseCliModelAccessRoute('relay')).toBe('included');
    expect(parseCliModelAccessRoute('personal')).toBe('personal');
    expect(parseCliModelAccessRoute('byok')).toBe('personal');
    expect(parseCliModelAccessRoute('direct')).toBeUndefined();
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
    // A completed request's route cannot change — `api-key` usage stays
    // personal even while the Kimi Code route is currently active.
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
        kimiCodeActive: true,
        usageRoute: 'api-key',
      }),
    ).toBe('personal');
  });

  it('preserves recorded Kimi Code subscription usage', () => {
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
        kimiCodeActive: false,
        usageRoute: 'kimi-code-subscription',
      }),
    ).toBe('kimi-code');
  });

  it('describes a prospective Kimi Code route above either fallback', () => {
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'personal',
        subscriptionActive: false,
        kimiCodeActive: true,
      }),
    ).toBe('kimi-code');
    expect(
      resolveCliModelAccessRoute({
        apiMode: 'included',
        subscriptionActive: false,
        kimiCodeActive: true,
      }),
    ).toBe('kimi-code');
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

  it('reports the same ChatGPT status used by the extension', async () => {
    mocks.getChatGptAuthStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
      accountId: null,
      preferSubscription: true,
      subscriptionToolUseOnly: false,
    });

    await expect(readCliModelAccessStatus('included')).resolves.toEqual({
      apiMode: 'included',
      chatGpt: {
        signedIn: true,
        email: 'user@example.com',
        accountId: null,
        preferSubscription: true,
        subscriptionToolUseOnly: false,
      },
      kimiCode: { keySet: false, preferred: false },
      personalApiKeySet: false,
    });

    mocks.getChatGptAuthStatus.mockResolvedValue({
      signedIn: false,
      email: null,
      accountId: null,
      preferSubscription: true,
      subscriptionToolUseOnly: false,
    });
    await expect(readCliModelAccessStatus('included')).resolves.toEqual({
      apiMode: 'included',
      chatGpt: {
        signedIn: false,
        email: null,
        accountId: null,
        preferSubscription: true,
        subscriptionToolUseOnly: false,
      },
      kimiCode: { keySet: false, preferred: false },
      personalApiKeySet: false,
    });
  });

  it('reports Kimi Code independently of the API fallback', async () => {
    mocks.apiKeyExists.mockImplementation(
      async (_secrets: unknown, provider: string) => provider === 'kimiCode',
    );
    mocks.getPreferKimiCode.mockReturnValue(true);

    await expect(readCliModelAccessStatus('personal')).resolves.toEqual({
      apiMode: 'personal',
      chatGpt: {
        signedIn: false,
        email: null,
        accountId: null,
        preferSubscription: false,
        subscriptionToolUseOnly: false,
      },
      kimiCode: { keySet: true, preferred: true },
      personalApiKeySet: false,
    });

    // Included access remains the fallback beneath the Kimi preference.
    await expect(readCliModelAccessStatus('included')).resolves.toMatchObject({
      apiMode: 'included',
      kimiCode: { keySet: true, preferred: true },
    });

    // A missing key falls back to plain personal access.
    mocks.apiKeyExists.mockResolvedValue(false);
    await expect(readCliModelAccessStatus('personal')).resolves.toMatchObject({
      apiMode: 'personal',
      kimiCode: { keySet: false, preferred: true },
    });
  });

  it('enables Kimi Code routing on a personal fallback when a key exists', async () => {
    mocks.apiKeyExists.mockResolvedValue(true);

    const result = await selectCliModelAccessRoute(context, 'kimi-code', {
      writeProgress: vi.fn(),
    });

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
        'Kimi Code subscription preference: On for Kimi models · fallback: Personal API keys.',
    });
  });

  it('guides to key entry when Kimi Code is selected without a key', async () => {
    const result = await selectCliModelAccessRoute(context, 'kimi-code', {
      writeProgress: vi.fn(),
    });

    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).not.toHaveBeenCalled();
    expect(result.apiMode).toBe('personal');
    expect(result.message).toContain('No Kimi Code API key configured');
    expect(result.message).toContain('https://www.kimi.com/code/console');
  });

  it('preserves Kimi Code preference when personal fallback is selected', async () => {
    await selectCliModelAccessRoute(context, 'personal', {
      writeProgress: vi.fn(),
    });

    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
  });

  it('preserves the Kimi prefer switch on the key-save path', async () => {
    // Saving or rotating a key is a credential operation, not an explicit
    // "Personal API keys" picker choice — it must not clear the preference.
    await selectCliApiModelAccessRoute('personal');

    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
  });

  it('keeps ChatGPT and Kimi preferences independent', async () => {
    mocks.apiKeyExists.mockResolvedValue(true);
    mocks.isPreferCodexSubscription.mockReturnValue(true);

    const result = await selectCliModelAccessRoute(context, 'kimi-code', {
      writeProgress: vi.fn(),
    });

    expect(mocks.setPreferKimiCode).toHaveBeenCalledWith(true);
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(result.message).toContain('Kimi Code subscription preference: On');
  });

  it('keeps the Kimi Code prefer switch when included access is chosen', async () => {
    await selectCliModelAccessRoute(context, 'included', {
      writeProgress: vi.fn(),
    });

    expect(mocks.setPreferKimiCode).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('included');
  });

  it('switches API-based routes through one policy boundary', async () => {
    const result = await selectCliModelAccessRoute(context, 'personal', {
      writeProgress: vi.fn(),
    });

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(result).toEqual({
      apiMode: 'personal',
      message: 'API fallback: Personal API keys.',
    });
  });

  it('changes the fallback without changing ChatGPT preference', async () => {
    const result = await selectCliApiModelAccessRoute('personal');

    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(result.message).toBe('API fallback: Personal API keys.');
  });

  it('does not report an API route as selected when persistence fails', async () => {
    mocks.setCliApiMode.mockRejectedValue(new Error('Config write failed'));

    await expect(selectCliApiModelAccessRoute('included')).rejects.toThrow(
      'Config write failed',
    );
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
  });

  it('signs in when needed and enables ChatGPT without an API key', async () => {
    mocks.signInCliChatGpt.mockResolvedValue({ email: 'user@example.com' });
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });
    const writeProgress = vi.fn();
    const controller = new AbortController();

    const result = await selectCliModelAccessRoute(context, 'chatgpt', {
      writeProgress,
      signal: controller.signal,
    });

    expect(mocks.signInCliChatGpt).toHaveBeenCalledWith(
      { device: false, noBrowser: false },
      { signal: controller.signal, writeProgress },
    );
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(true);
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result.message).toBe(
      'ChatGPT subscription preference: On for Codex models (user@example.com).',
    );
    expect(result.apiMode).toBe('personal');
  });

  it('toggles off an enabled ChatGPT preference', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: false,
      target: 'global',
    });

    const result = await selectCliModelAccessRoute(context, 'chatgpt', {
      writeProgress: vi.fn(),
    });

    expect(mocks.signInCliChatGpt).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      apiMode: 'personal',
      message: 'ChatGPT subscription preference: Off.',
    });
  });

  it('signs in instead of toggling off a stale signed-out preference', async () => {
    mocks.isPreferCodexSubscription.mockReturnValue(true);
    mocks.signInCliChatGpt.mockResolvedValue({ email: 'user@example.com' });
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });

    await selectCliModelAccessRoute(context, 'chatgpt', {
      writeProgress: vi.fn(),
    });

    expect(mocks.signInCliChatGpt).toHaveBeenCalledOnce();
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(true);
  });
});
