import { Console } from 'node:console';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForCondition } from '@test/support/asyncTestUtils';
import { FakeStdin, FakeStdout } from '@test/support/inkTestHarness.ts';

const mocks = vi.hoisted(() => ({
  updateCliModelAccess: vi.fn(),
  saveProviderApiKey: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStdout: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('@cli/runtime/modelAccessSelection', () => ({
  updateCliModelAccess: mocks.updateCliModelAccess,
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
  mocks.updateCliModelAccess.mockReset();
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
  it('emits the access-route warning returned after the submitted key without exposing the key', async () => {
    const warning =
      'DISTINCTIVE OVERRIDE: workspace policy keeps ChatGPT subscription active.';
    const providerKey = 'sk-ant-integration-secret';
    mocks.updateCliModelAccess.mockResolvedValue({
      apiMode: 'personal',
      message: warning,
    });

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
    await waitForCondition(
      () =>
        stdin.listenerCount('readable') > 0 &&
        stdout.output.includes('Choose how to power model calls'),
      ONBOARDING_WAIT_OPTIONS,
    );
    stdin.write('3');
    await waitForCondition(
      () => stdout.output.includes('Choose your provider:'),
      ONBOARDING_WAIT_OPTIONS,
    );
    stdin.write('\r');
    await waitForCondition(
      () => stdout.output.includes('enter your API key (hidden)'),
      ONBOARDING_WAIT_OPTIONS,
    );
    stdin.write(providerKey);
    await waitForCondition(
      () => stdout.output.includes('•'),
      ONBOARDING_WAIT_OPTIONS,
    );
    stdin.write('\r');

    await expect(resultPromise).resolves.toEqual({
      configured: true,
      declined: false,
    });
    expect(mocks.saveProviderApiKey).toHaveBeenCalledWith(
      'anthropic',
      providerKey,
    );
    expect(mocks.updateCliModelAccess).toHaveBeenCalledWith(undefined, {
      kind: 'api-fallback',
      apiMode: 'personal',
    });
    expect(mocks.writeTextStdout).toHaveBeenCalledWith(
      'Saved your Anthropic API key. Stored in TeXRA secrets as `apiKey.anthropic` (or set ANTHROPIC_API_KEY in your environment). ' +
        warning,
    );
    expect(mocks.writeTextStdout).not.toHaveBeenCalledWith(
      expect.stringContaining(providerKey),
    );
    expect(stdout.output).not.toContain(providerKey);
  }, 30_000);
});
