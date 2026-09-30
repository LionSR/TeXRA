import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

import { testRuntime } from '@test/support/testProcessRuntime';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
  signOutCliSubscription: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', async () => {
  const { Effect } = await import('effect');
  return {
    installCliProcessRuntime: mocks.installCliProcessRuntime,
    disposeCliProcessRuntime: Effect.void,
  };
});

vi.mock('@cli/runtime/subscriptionLogin', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/subscriptionLogin')>();
  return {
    ...actual,
    signOutCliSubscription: mocks.signOutCliSubscription,
  };
});

const { runCli } = await import('@cli/commands/root');

describe('CLI auth command', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    mocks.initCliPlatform
      .mockReset()
      .mockReturnValue(Effect.succeed({ runtime: testRuntime() }));
    mocks.installCliProcessRuntime
      .mockReset()
      .mockImplementation(() => testRuntime());
    mocks.signOutCliSubscription
      .mockReset()
      .mockReturnValue(Effect.succeed({}));
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

  it('reports ChatGPT logout success when preference cleanup fails', async () => {
    mocks.signOutCliSubscription.mockReturnValueOnce(
      Effect.succeed({ preferenceError: 'Config write failed' }),
    );

    const result = await runCli(['auth', 'chatgpt', 'logout']);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Signed out of ChatGPT.');
    expect(stdout).toContain(
      'ChatGPT subscription could not be disabled: Config write failed',
    );
    expect(stderr).toBe('');
  });
});
