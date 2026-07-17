import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
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

const mocks = vi.hoisted(() => ({
  getCodexStatus: vi.fn(),
  isPreferCodexSubscription: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  setCliApiMode: vi.fn(),
  shouldUseChatGptDeviceCode: vi.fn(),
  signInCliChatGpt: vi.fn(),
  updateGlobalState: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({ globalState: { update: mocks.updateGlobalState } }),
}));

vi.mock('@auth/codex', () => ({
  getCodexStatus: mocks.getCodexStatus,
  isPreferCodexSubscription: mocks.isPreferCodexSubscription,
  setPreferCodexSubscription: mocks.setPreferCodexSubscription,
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
  mocks.isPreferCodexSubscription.mockReturnValue(false);
  mocks.setPreferCodexSubscription.mockResolvedValue({
    effective: false,
    target: 'global',
  });
  mocks.setCliApiMode.mockResolvedValue(undefined);
  mocks.shouldUseChatGptDeviceCode.mockReturnValue(false);
});

describe('CLI model access routes', () => {
  it('parses the three routes and the subscription compatibility spelling', () => {
    expect(parseCliModelAccessRoute('chatgpt')).toBe('chatgpt');
    expect(parseCliModelAccessRoute('subscription')).toBe('chatgpt');
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

  it('formats the shared access routes for detailed and compact surfaces', () => {
    expect(formatCliModelAccessRoute('chatgpt')).toBe('ChatGPT subscription');
    expect(formatCliModelAccessRoute('included')).toBe('Included TeXRA access');
    expect(formatCliModelAccessRoute('personal')).toBe('Personal API keys');
    expect(formatCliModelAccessRouteInline('chatgpt')).toBe(
      'ChatGPT subscription',
    );
    expect(formatCliModelAccessRouteInline('included')).toBe(
      'included TeXRA access',
    );
    expect(formatCliModelAccessRouteInline('personal')).toBe(
      'personal API keys',
    );
    expect(shortCliModelAccessRoute('chatgpt')).toBe('subscription');
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

  it('reports ChatGPT only when sign-in and preference are both active', async () => {
    mocks.getCodexStatus.mockResolvedValue({
      signedIn: true,
      email: 'user@example.com',
    });
    mocks.isPreferCodexSubscription.mockReturnValue(true);

    await expect(readCliModelAccessStatus('included')).resolves.toEqual({
      active: 'chatgpt',
      chatGptSignedIn: true,
      chatGptAccountLabel: 'user@example.com',
    });

    mocks.getCodexStatus.mockResolvedValue({ signedIn: false });
    await expect(readCliModelAccessStatus('included')).resolves.toEqual({
      active: 'included',
      chatGptSignedIn: false,
    });
  });

  it('switches API-based routes through one policy boundary', async () => {
    const result = await selectCliModelAccessRoute(context, 'personal', {
      writeProgress: vi.fn(),
    });

    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(result).toEqual({
      apiMode: 'personal',
      message: 'Model access: Personal API keys.',
    });
  });

  it('reports when a more specific setting keeps ChatGPT active', async () => {
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'workspace',
    });

    const result = await selectCliApiModelAccessRoute('personal');

    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.setCliApiMode).toHaveBeenCalledWith('personal');
    expect(result.message).toContain(
      'remains on ChatGPT subscription because a more specific setting overrides workspace config',
    );
  });

  it('does not report an API route as selected when persistence fails', async () => {
    mocks.setCliApiMode.mockRejectedValue(new Error('Config write failed'));

    await expect(selectCliApiModelAccessRoute('included')).rejects.toThrow(
      'Config write failed',
    );
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
  });

  it('signs in when needed and enables ChatGPT without an API key', async () => {
    mocks.signInCliChatGpt.mockResolvedValue({ email: 'user@example.com' });
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });
    const writeProgress = vi.fn();

    const result = await selectCliModelAccessRoute(context, 'chatgpt', {
      writeProgress,
    });

    expect(mocks.signInCliChatGpt).toHaveBeenCalledWith(
      { device: false, noBrowser: false },
      { writeProgress },
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

  it('uses the ChatGPT row as a preference switch when already enabled', async () => {
    mocks.getCodexStatus.mockResolvedValue({ signedIn: true });
    mocks.isPreferCodexSubscription.mockReturnValue(true);

    const result = await selectCliModelAccessRoute(context, 'chatgpt', {
      writeProgress: vi.fn(),
    });

    expect(mocks.signInCliChatGpt).not.toHaveBeenCalled();
    expect(mocks.setPreferCodexSubscription).toHaveBeenCalledWith(false);
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(result).toEqual({
      apiMode: 'personal',
      message: 'Prefer ChatGPT subscription disabled for Codex models.',
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
