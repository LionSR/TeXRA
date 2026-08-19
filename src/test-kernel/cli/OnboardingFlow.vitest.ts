import { Console } from 'node:console';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForCondition } from '@test/support/asyncTestUtils';
import { FakeStdin, FakeStdout } from '@test/support/inkTestHarness.ts';

const mocks = vi.hoisted(() => ({
  saveProviderApiKey: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStdout: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('@cli/runtime/providerApiKey', () => ({
  saveProviderApiKey: mocks.saveProviderApiKey,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
  writeTextStdout: mocks.writeTextStdout,
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      get: (key: string, defaultValue?: unknown) =>
        mocks.state.has(key) ? mocks.state.get(key) : defaultValue,
      update: async (key: string, value: unknown) => {
        mocks.state.set(key, value);
      },
    },
  }),
}));

const ONBOARDING_WAIT_OPTIONS = Object.freeze({
  timeoutMs: 15_000,
  timeoutMessage: 'Timed out waiting for onboarding interaction',
});

function waitForOnboarding(condition: () => boolean): Promise<void> {
  return waitForCondition(condition, ONBOARDING_WAIT_OPTIONS);
}

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
const originalConsoleConstructor = Object.getOwnPropertyDescriptor(
  console,
  'Console',
);

function restoreProcessStream(
  name: 'stdin' | 'stdout' | 'stderr',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(process, name, descriptor);
}

beforeEach(() => {
  mocks.state.clear();
  mocks.saveProviderApiKey.mockReset().mockResolvedValue(undefined);
  mocks.writeTextStderr.mockReset();
  mocks.writeTextStdout.mockReset();
});

afterEach(() => {
  restoreProcessStream('stdin', originalStdin);
  restoreProcessStream('stdout', originalStdout);
  restoreProcessStream('stderr', originalStderr);
  if (originalConsoleConstructor) {
    Object.defineProperty(console, 'Console', originalConsoleConstructor);
  } else {
    Reflect.deleteProperty(console, 'Console');
  }
});

describe('provider-key onboarding flow', () => {
  it('saves the submitted key without exposing it', async () => {
    const providerKey = 'sk-ant-integration-secret';

    Object.defineProperty(console, 'Console', {
      value: Console,
      configurable: true,
    });
    const stdin = new FakeStdin();
    const stdout = new FakeStdout(100, 30);
    const stderr = new FakeStdout(100, 30);
    Object.defineProperties(process, {
      stdin: { value: stdin, configurable: true },
      stdout: { value: stdout, configurable: true },
      stderr: { value: stderr, configurable: true },
    });

    const { runCliOnboarding } = await import('@cli/onboarding/runOnboarding');
    const resultPromise = runCliOnboarding(false);

    // Ink attaches its input stream before the active Select handler has
    // necessarily committed. Wait for both input attachment and the rendered
    // picker so the shortcut cannot be discarded during a loaded CI run.
    await waitForOnboarding(
      () =>
        stdin.listenerCount('readable') > 0 &&
        stdout.output.includes('Choose how to power model calls'),
    );
    stdin.write('2');
    await waitForOnboarding(() =>
      stdout.output.includes('Choose your provider:'),
    );
    stdin.write('\r');
    await waitForOnboarding(() =>
      stdout.output.includes('enter your API key (hidden)'),
    );
    stdin.write(providerKey);
    await waitForOnboarding(() => stdout.output.includes('•'));
    stdin.write('\r');

    await expect(resultPromise).resolves.toEqual({
      configured: true,
      declined: false,
    });
    expect(mocks.saveProviderApiKey).toHaveBeenCalledWith(
      'anthropic',
      providerKey,
    );
    expect(mocks.writeTextStdout).toHaveBeenCalledWith(
      'Saved your Anthropic API key. Stored in TeXRA secrets as `apiKey.anthropic` (or set ANTHROPIC_API_KEY in your environment).',
    );
    expect(mocks.writeTextStdout).not.toHaveBeenCalledWith(
      expect.stringContaining(providerKey),
    );
    expect(stdout.output).not.toContain(providerKey);
  }, 30_000);
});
