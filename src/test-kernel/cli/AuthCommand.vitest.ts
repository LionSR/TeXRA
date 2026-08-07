import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

const mocks = vi.hoisted(() => ({
  getCliAuthProfile: vi.fn(),
  initCliPlatform: vi.fn(),
  signOutCliChatGpt: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/supabaseAuth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/supabaseAuth')>();
  return {
    ...actual,
    getCliAuthProfile: mocks.getCliAuthProfile,
  };
});

vi.mock('@cli/runtime/chatgptLogin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/chatgptLogin')>();
  return {
    ...actual,
    signOutCliChatGpt: mocks.signOutCliChatGpt,
  };
});

const { runCli } = await import('@cli/commands/root');

const SIGNED_IN_PROFILE = {
  authenticated: true,
  accountLabel: 'user@example.edu',
  tier: 'Max',
};

describe('CLI auth command', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    mocks.getCliAuthProfile.mockReset().mockResolvedValue({
      authenticated: false,
    });
    mocks.initCliPlatform.mockReset().mockResolvedValue(undefined);
    mocks.signOutCliChatGpt.mockReset().mockResolvedValue({
      preferenceUpdate: { effective: false, target: 'global' },
    });
    stdoutSpy = spyOnStreamWrite(process.stdout, (text) => {
      stdout += text;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (text) => {
      stderr += text;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('defaults bare auth to status while accepting global flags', async () => {
    const result = await runCli(['auth', '--no-color']);

    expect(result.exitCode).toBe(0);
    expect(stdout.trim()).toBe('Not signed in.');
    expect(stderr).toBe('');
    expect(mocks.initCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ quietLogs: true }),
    );
  });

  it('explains an auth-service outage instead of inviting a re-login', async () => {
    mocks.getCliAuthProfile.mockResolvedValueOnce({
      authenticated: false,
      sessionState: 'transient',
    });

    const result = await runCli(['auth', '--no-color']);

    expect(result.exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      'The authentication service is temporarily unavailable. Your stored session is intact; try again later.',
    );
    expect(stderr).toBe('');
  });

  it('honors structured output on bare auth status', async () => {
    mocks.getCliAuthProfile.mockResolvedValueOnce(SIGNED_IN_PROFILE);

    const result = await runCli([
      'auth',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(SIGNED_IN_PROFILE);
    expect(stderr).toBe('');
  });

  it('forwards group-level global flags to explicit auth subcommands', async () => {
    mocks.getCliAuthProfile.mockResolvedValueOnce(SIGNED_IN_PROFILE);

    const result = await runCli(['auth', '--output-format', 'json', 'status']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(SIGNED_IN_PROFILE);
    expect(stderr).toBe('');
  });

  it('clears ChatGPT subscription preference on chatgpt logout', async () => {
    const result = await runCli([
      'auth',
      'chatgpt',
      'logout',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    expect(mocks.signOutCliChatGpt).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout)).toEqual({
      authenticated: false,
      preferSubscription: false,
    });
    expect(stderr).toBe('');
  });

  it('reports ChatGPT logout success when preference cleanup fails', async () => {
    mocks.signOutCliChatGpt.mockResolvedValueOnce({
      preferenceError: 'Config write failed',
    });

    const result = await runCli(['auth', 'chatgpt', 'logout']);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Signed out of ChatGPT.');
    expect(stdout).toContain(
      'ChatGPT subscription preference could not be disabled: Config write failed',
    );
    expect(stderr).toBe('');
  });
});
