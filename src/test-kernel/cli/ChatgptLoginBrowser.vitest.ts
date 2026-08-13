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
}));

vi.mock('@model/codex/codexPreference', () => ({
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

/** Drive the loopback transport through the sign-in URL it would publish. */
function publishLoopbackUrl(url: string): void {
  mocks.loginWithLoopback.mockImplementation(async ({ openBrowser }) => {
    await openBrowser(url);
    return loopbackSession();
  });
}

async function runSignIn(url: string, noBrowser = false): Promise<string[]> {
  publishLoopbackUrl(url);
  const progress: string[] = [];
  await signInCliChatGpt(
    { device: false, noBrowser },
    { writeProgress: (message) => progress.push(message) },
  );
  return progress;
}

describe('signInCliChatGpt browser choice', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints the sign-in link once, then browser status without repeating the URL', async () => {
    mocks.tryOpenBrowser.mockResolvedValue(true);

    const progress = await runSignIn('https://auth.openai.com/authorize?x=1');

    expect(progress).toEqual([
      'ChatGPT sign-in URL:\nhttps://auth.openai.com/authorize?x=1',
      'Browser launch in progress...',
      'Browser opened; the same URL works in another browser.',
    ]);
  });

  it('prints the URL once when the browser fails to launch', async () => {
    mocks.tryOpenBrowser.mockResolvedValue(false);

    const progress = await runSignIn('https://auth.openai.com/authorize?x=2');

    expect(progress).toEqual([
      'ChatGPT sign-in URL:\nhttps://auth.openai.com/authorize?x=2',
      'Browser launch in progress...',
      'Automatic browser launch failed; open the sign-in URL above.',
    ]);
  });

  it('skips the launch attempt and prints the URL with --no-browser', async () => {
    const progress = await runSignIn(
      'https://auth.openai.com/authorize?x=3',
      true,
    );

    expect(mocks.tryOpenBrowser).not.toHaveBeenCalled();
    expect(progress).toEqual([
      'ChatGPT sign-in URL:\nhttps://auth.openai.com/authorize?x=3',
    ]);
  });

  it('publishes the URL before a slow browser launcher returns', async () => {
    let finishLaunch: ((result: boolean) => void) | undefined;
    mocks.tryOpenBrowser.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishLaunch = resolve;
      }),
    );
    publishLoopbackUrl('https://auth.openai.com/authorize?x=slow');
    const progress: string[] = [];

    const signIn = signInCliChatGpt(
      { device: false, noBrowser: false },
      { writeProgress: (message) => progress.push(message) },
    );

    await vi.waitFor(() => {
      expect(progress[0]).toContain('https://auth.openai.com/authorize?x=slow');
    });
    finishLaunch?.(true);
    await signIn;
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
