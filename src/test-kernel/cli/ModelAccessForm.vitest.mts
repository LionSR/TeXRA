import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelAccessForm } from '@cli/chat/tui/forms/ModelAccessForm';

const loadCliModelAccessOverview = vi.hoisted(() => vi.fn());

vi.mock('@cli/runtime/apiStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/apiStatus')>()),
  loadCliModelAccessOverview,
}));

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  output = '';

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }

  getColorDepth(): number {
    return 24;
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;

  read(): null {
    return null;
  }

  ref(): void {}
  unref(): void {}
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  setRawMode(): void {}
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => vi.clearAllMocks());

describe('ModelAccessForm status', () => {
  it('does not mark an unverified API fallback active after loading fails', async () => {
    loadCliModelAccessOverview.mockRejectedValue(
      new Error('model access unavailable'),
    );
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const stdout = new FakeStdout();
    const instance = ink.render(
      React.createElement(ModelAccessForm, {
        apiMode: 'included',
        onSelect: () => undefined,
        onCancel: () => undefined,
      }),
      {
        stdin: new FakeStdin(),
        stdout,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => loadCliModelAccessOverview.mock.calls.length > 0);
      await waitFor(() => stdout.output.includes('model access unavailable'));
      expect(stdout.output).toContain('model access unavailable');
      expect(stdout.output).toContain('Sign in through Account');
      expect(stdout.output).not.toContain('Use your TeXRA account');
      expect(stdout.output).not.toContain('✓');
    } finally {
      instance.unmount();
    }
  });
});
