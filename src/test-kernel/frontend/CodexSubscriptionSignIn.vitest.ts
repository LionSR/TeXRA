import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loginWithLoopback: vi.fn(),
  invalidateModelOptionsCache: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  showLoggedErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock('vscode', () => ({
  env: {
    remoteName: undefined,
    openExternal: mocks.openExternal,
    clipboard: { writeText: mocks.writeText },
  },
  ProgressLocation: { Notification: 15 },
  Uri: {
    parse: (value: string) => ({ toString: () => value }),
  },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    withProgress: mocks.withProgress,
  },
}));

vi.mock('@auth/codex', () => ({
  codexCoordinator: vi.fn(() => ({})),
  loginWithDeviceCode: vi.fn(),
  loginWithLoopback: mocks.loginWithLoopback,
  setPreferCodexSubscription: mocks.setPreferCodexSubscription,
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: mocks.showLoggedErrorMessage,
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

const { signInWithChatGptSubscription } =
  await import('@frontend/auth/codexSubscriptionSignIn');

function loopbackSession() {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 60_000,
    email: 'person@example.com',
  };
}

describe('signInWithChatGptSubscription', () => {
  beforeEach(() => {
    mocks.withProgress.mockImplementation((_options, task) => task());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports OAuth failures as sign-in failures', async () => {
    mocks.loginWithLoopback.mockRejectedValue(new Error('oauth failed'));

    const signedIn = await signInWithChatGptSubscription('TestChannel');

    expect(signedIn).toBe(false);
    expect(mocks.showLoggedErrorMessage).toHaveBeenCalledWith(
      'TestChannel',
      'ChatGPT sign-in failed',
      expect.any(Error),
    );
    expect(mocks.setPreferCodexSubscription).not.toHaveBeenCalled();
  });

  it('does not treat a completed OAuth sign-in as a sign-in failure when preference update fails', async () => {
    mocks.loginWithLoopback.mockResolvedValue(loopbackSession());
    mocks.setPreferCodexSubscription.mockRejectedValue(
      new Error('config write failed'),
    );

    const signedIn = await signInWithChatGptSubscription('TestChannel');

    expect(signedIn).toBe(false);
    expect(mocks.showLoggedErrorMessage).toHaveBeenCalledWith(
      'TestChannel',
      'ChatGPT sign-in succeeded but subscription preference update failed',
      expect.any(Error),
    );
    expect(mocks.showLoggedErrorMessage).not.toHaveBeenCalledWith(
      'TestChannel',
      'ChatGPT sign-in failed',
      expect.any(Error),
    );
  });

  it('warns when a more specific setting keeps subscription preference disabled', async () => {
    mocks.loginWithLoopback.mockResolvedValue(loopbackSession());
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: false,
      target: 'global',
    });

    const signedIn = await signInWithChatGptSubscription('TestChannel');

    expect(signedIn).toBe(false);
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Signed in with ChatGPT as person@example.com, but a more specific setting kept the subscription preference disabled.',
    );
  });

  it('opens the default browser and offers the link for a non-default browser', async () => {
    mocks.openExternal.mockResolvedValue(true);
    mocks.showInformationMessage.mockResolvedValue('Copy Sign-in Link');
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });
    mocks.loginWithLoopback.mockImplementation(async ({ openBrowser }) => {
      await openBrowser('https://auth.openai.com/authorize?x=1');
      return loopbackSession();
    });

    await signInWithChatGptSubscription('TestChannel');
    // The deferred clipboard write is queued on a resolved-promise microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('different browser'),
      'Copy Sign-in Link',
    );
    expect(mocks.writeText).toHaveBeenCalledWith(
      'https://auth.openai.com/authorize?x=1',
    );
  });

  it('returns true when OAuth and preference enablement both succeed', async () => {
    mocks.loginWithLoopback.mockResolvedValue(loopbackSession());
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });

    const signedIn = await signInWithChatGptSubscription('TestChannel');

    expect(signedIn).toBe(true);
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Signed in with ChatGPT as person@example.com. ChatGPT subscription is enabled for Codex models.',
    );
  });
});
