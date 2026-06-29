// Renders the bare-`texra` orchestration launcher to an in-memory stdout and
// asserts the CLI version shows in the header — the same way the chat session
// header reports it — so a directly-launched `texra` says which build it is.
//
// Ink/React are loaded through the CLI package's own resolution (the patched
// workspace Ink) and the component is imported afterwards, so the render()
// reconciler and the component share one Ink/React instance (see
// StaticBandResize.vitest for the same dance).

process.env.FORCE_COLOR ??= '3';

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { delay } from '@utils/core/async';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  buf = '';
  write(chunk: string): boolean {
    this.buf += chunk;
    return true;
  }
  getColorDepth(): number {
    return 24;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = false;
  ref(): void {}
  unref(): void {}
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  read(): null {
    return null;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

describe('orchestration launcher header', () => {
  it('shows the CLI version beside the TeXRA title', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const { createElement } = (
      (await import(cliRequire.resolve('react'))) as any
    ).default;
    const { OrchestrationApp } =
      await import('@cli/orchestration/runOrchestrationTui');

    const stdout = new FakeStdout();
    const instance = ink.render(
      createElement(OrchestrationApp, {
        items: [
          {
            value: { kind: 'chat' },
            label: 'New chat',
            description: 'Start the default tool-use chat',
          },
          {
            value: { kind: 'help' },
            label: 'Help',
            description: 'Show CLI commands',
          },
        ],
        models: [],
        apiMode: 'included',
        version: '9.9.9-test',
        onResolve: () => undefined,
      }),
      {
        stdout,
        stdin: new FakeStdin(),
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      expect(await waitFor(() => stdout.buf.includes('v9.9.9-test'))).toBe(
        true,
      );
      expect(stdout.buf).toContain('TeXRA');
    } finally {
      instance.unmount();
    }
  });
});
