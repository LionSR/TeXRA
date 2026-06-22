import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loginWithLoopback: vi.fn(),
  setPreferCodexSubscription: vi.fn(),
  showLoggedErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  openExternal: vi.fn(),
  withProgress: vi.fn(),
}));

vi.mock('vscode', () => ({
  env: {
    remoteName: undefined,
    openExternal: mocks.openExternal,
    clipboard: { writeText: vi.fn() },
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

const { signInWithChatGptSubscription } =
  await import('@frontend/auth/codexSubscriptionSignIn');

describe('signInWithChatGptSubscription', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports OAuth failures as sign-in failures', async () => {
    mocks.withProgress.mockImplementation((_options, task) => task());
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

  it('does not call a completed OAuth sign-in a sign-in failure when preference update fails', async () => {
    mocks.withProgress.mockImplementation((_options, task) => task());
    mocks.loginWithLoopback.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAtMs: Date.now() + 60_000,
      email: 'person@example.com',
    });
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

  it('returns true when OAuth and preference enablement both succeed', async () => {
    mocks.withProgress.mockImplementation((_options, task) => task());
    mocks.loginWithLoopback.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAtMs: Date.now() + 60_000,
      email: 'person@example.com',
    });
    mocks.setPreferCodexSubscription.mockResolvedValue({
      effective: true,
      target: 'global',
    });

    const signedIn = await signInWithChatGptSubscription('TestChannel');

    expect(signedIn).toBe(true);
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'Signed in with ChatGPT as person@example.com. ChatGPT subscription is enabled for Codex models.',
    );
  });
});
