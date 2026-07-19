import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  codexCoordinator: vi.fn(() => ({})),
  loginWithDeviceCode: vi.fn(),
  loginWithLoopback: vi.fn(),
  tryOpenBrowser: vi.fn(),
}));

vi.mock('@auth/codex', () => ({
  codexCoordinator: mocks.codexCoordinator,
  loginWithDeviceCode: mocks.loginWithDeviceCode,
  loginWithLoopback: mocks.loginWithLoopback,
  setPreferCodexSubscription: vi.fn(),
}));

vi.mock('@cli/runtime/browser', () => ({
  tryOpenBrowser: mocks.tryOpenBrowser,
}));

const { signInCliChatGpt } = await import('@cli/runtime/chatgptLogin');

function loopbackSession() {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 60_000,
  };
}

describe('signInCliChatGpt browser choice', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints the sign-in link even after a successful browser launch', async () => {
    mocks.tryOpenBrowser.mockResolvedValue(true);
    mocks.loginWithLoopback.mockImplementation(async ({ openBrowser }) => {
      await openBrowser('https://auth.openai.com/authorize?x=1');
      return loopbackSession();
    });
    const progress: string[] = [];

    await signInCliChatGpt(
      { device: false, noBrowser: false },
      { writeProgress: (message) => progress.push(message) },
    );

    expect(progress).toHaveLength(1);
    expect(progress[0]).toContain('https://auth.openai.com/authorize?x=1');
    expect(progress[0]).toContain('different browser');
  });

  it('prints only the URL when the browser fails to launch', async () => {
    mocks.tryOpenBrowser.mockResolvedValue(false);
    mocks.loginWithLoopback.mockImplementation(async ({ openBrowser }) => {
      await openBrowser('https://auth.openai.com/authorize?x=2');
      return loopbackSession();
    });
    const progress: string[] = [];

    await signInCliChatGpt(
      { device: false, noBrowser: false },
      { writeProgress: (message) => progress.push(message) },
    );

    expect(progress).toEqual([
      'Open this URL to sign in with ChatGPT:\nhttps://auth.openai.com/authorize?x=2',
    ]);
  });

  it('skips the launch attempt and prints the URL with --no-browser', async () => {
    mocks.loginWithLoopback.mockImplementation(async ({ openBrowser }) => {
      await openBrowser('https://auth.openai.com/authorize?x=3');
      return loopbackSession();
    });
    const progress: string[] = [];

    await signInCliChatGpt(
      { device: false, noBrowser: true },
      { writeProgress: (message) => progress.push(message) },
    );

    expect(mocks.tryOpenBrowser).not.toHaveBeenCalled();
    expect(progress).toEqual([
      'Open this URL to sign in with ChatGPT:\nhttps://auth.openai.com/authorize?x=3',
    ]);
  });

  it('forwards interactive cancellation to both ChatGPT transports', async () => {
    const loopbackSessionResult = loopbackSession();
    mocks.loginWithLoopback.mockResolvedValue(loopbackSessionResult);
    mocks.loginWithDeviceCode.mockResolvedValue(loopbackSessionResult);
    const controller = new AbortController();
    const options = {
      signal: controller.signal,
      writeProgress: vi.fn(),
    };

    await signInCliChatGpt({ device: false, noBrowser: true }, options);
    await signInCliChatGpt({ device: true, noBrowser: false }, options);

    expect(mocks.loginWithLoopback).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(mocks.loginWithDeviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
