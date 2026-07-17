import { Console } from 'node:console';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectCliApiModelAccessRoute: vi.fn(),
  saveProviderApiKey: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStdout: vi.fn(),
  state: new Map<string, unknown>(),
}));

vi.mock('@cli/runtime/modelAccessSelection', () => ({
  selectCliApiModelAccessRoute: mocks.selectCliApiModelAccessRoute,
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

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
  readonly fd = 1;
  readonly destroyed = false;
  output = '';

  write(chunk: string | Uint8Array, ...args: unknown[]): boolean {
    this.output += Buffer.isBuffer(chunk)
      ? chunk.toString('utf8')
      : String(chunk);
    const callback = args.findLast(
      (arg): arg is () => void => typeof arg === 'function',
    );
    callback?.();
    return true;
  }

  getColorDepth(): number {
    return 24;
  }
}

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  readonly fd = 0;
  private readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
    this.emit('readable');
  }

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  ref(): void {}
  unref(): void {}
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  setRawMode(): this {
    return this;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for onboarding interaction');
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
  mocks.selectCliApiModelAccessRoute.mockReset();
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
    mocks.selectCliApiModelAccessRoute.mockResolvedValue({
      apiMode: 'personal',
      message: warning,
    });

    Object.defineProperty(console, 'Console', {
      value: Console,
      configurable: true,
    });
    const stdin = new FakeInput();
    const stdout = new FakeOutput();
    const stderr = new FakeOutput();
    Object.defineProperties(process, {
      stdin: { value: stdin, configurable: true },
      stdout: { value: stdout, configurable: true },
      stderr: { value: stderr, configurable: true },
    });

    const { runCliOnboarding } = await import('@cli/onboarding/runOnboarding');
    const resultPromise = runCliOnboarding(false);

    await waitFor(() => stdin.listenerCount('readable') > 0);
    stdin.write('3');
    await waitFor(() => stdout.output.includes('Choose your provider:'));
    stdin.write('\r');
    await waitFor(() => stdout.output.includes('enter your API key (hidden)'));
    stdin.write(providerKey);
    await waitFor(() => stdout.output.includes('•'));
    stdin.write('\r');

    await expect(resultPromise).resolves.toEqual({
      configured: true,
      declined: false,
    });
    expect(mocks.saveProviderApiKey).toHaveBeenCalledWith(
      'anthropic',
      providerKey,
    );
    expect(mocks.selectCliApiModelAccessRoute).toHaveBeenCalledWith('personal');
    expect(mocks.writeTextStdout).toHaveBeenCalledWith(
      'Saved your Anthropic API key. Stored in TeXRA secrets as `apiKey.anthropic` (or set ANTHROPIC_API_KEY in your environment). ' +
        warning,
    );
    expect(mocks.writeTextStdout).not.toHaveBeenCalledWith(
      expect.stringContaining(providerKey),
    );
    expect(stdout.output).not.toContain(providerKey);
  });
});
