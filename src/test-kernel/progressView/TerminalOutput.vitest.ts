// Third-party imports
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

// Local imports
import { resolveXtermTheme } from '@ui/wa/xtermTheme';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/TerminalOutput'),
);

// Loaded after useLitComponentTestDom's beforeAll installs the jsdom globals
// this module touches at import time.
type TerminalOutputElement =
  import('@progressView/frontend/components/TerminalOutput').TerminalOutput;

// xterm is stubbed at the prototype: opening a renderer needs layout jsdom
// does not have, and what these tests pin is what the element writes and how
// it sizes scrollback, not xterm's own rendering.
let writes: string[];
let resetCount: number;
let terminals: Terminal[];

beforeAll(async () => {
  await import('@progressView/frontend/components/TerminalOutput');
  vi.spyOn(Terminal.prototype, 'open').mockImplementation(function (
    this: Terminal,
  ) {
    terminals.push(this);
  });
  vi.spyOn(Terminal.prototype, 'write').mockImplementation(
    (data: string | Uint8Array, callback?: () => void) => {
      writes.push(String(data));
      callback?.();
    },
  );
  vi.spyOn(Terminal.prototype, 'reset').mockImplementation(() => {
    resetCount += 1;
  });
});

beforeEach(() => {
  writes = [];
  resetCount = 0;
  terminals = [];
});

/** Flush the element's async write loop (kicked from `updated()`). */
async function flushTerminal(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountTerminal(): Promise<TerminalOutputElement> {
  const element = document.createElement(
    'terminal-output',
  ) as TerminalOutputElement;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

describe('terminal-output text updates', () => {
  it('writes only the appended suffix when output grows', async () => {
    const element = await mountTerminal();

    element.text = 'alpha\n';
    await flushTerminal();
    element.text = 'alpha\nbeta\n';
    await flushTerminal();

    expect(writes).toEqual(['alpha\n', 'beta\n']);
    expect(resetCount).toBe(0);
  });

  it('resets and rewrites everything when retained output is replaced', async () => {
    const element = await mountTerminal();

    element.text = 'alpha\nbeta\n';
    await flushTerminal();
    element.text = 'beta\n';
    await flushTerminal();

    expect(resetCount).toBe(1);
    expect(writes).toEqual(['alpha\nbeta\n', 'beta\n']);
  });
});

describe('resolveXtermTheme', () => {
  it('names each unresolved terminal token in a console warning', () => {
    // A host that maps the terminal pair to variables it never injects
    // resolves them to ''; the warning keeps that broken mapping visible
    // instead of silently keeping the surface palette.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = document.createElement('div');
    target.style.setProperty('--wa-color-terminal-background', '#111111');
    document.body.append(target);

    const { theme } = resolveXtermTheme(target);

    expect(theme.background).toBe('#111111');
    expect(theme.foreground).toBe('#cccccc');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('--wa-color-terminal-foreground');
    expect(warn.mock.calls[0]?.[0]).not.toContain(
      '--wa-color-terminal-background',
    );
    warn.mockRestore();
  });
});
