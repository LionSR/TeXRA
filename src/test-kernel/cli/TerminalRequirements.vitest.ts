import { describe, expect, it } from 'vitest';

import {
  dumbTerminalMessage,
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '@cli/runtime/terminalRequirements';

describe('terminal requirement diagnostics', () => {
  const DUMB_TERMINAL_HINT =
    'texra chat needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`.';

  it('classifies interactive terminal failures once for CLI entry points', () => {
    const cases: ReadonlyArray<{
      input: Parameters<typeof interactiveTerminalFailure>[0];
      expected: ReturnType<typeof interactiveTerminalFailure>;
    }> = [
      {
        input: { mode: 'headless', stdoutIsTty: true, termIsDumb: false },
        expected: 'headless',
      },
      {
        input: { mode: 'interactive', stdoutIsTty: false, termIsDumb: false },
        expected: 'headless',
      },
      {
        input: { mode: 'interactive', stdoutIsTty: true, termIsDumb: true },
        expected: 'dumb-terminal',
      },
      {
        input: { mode: 'interactive', stdoutIsTty: true, termIsDumb: false },
        expected: undefined,
      },
    ];

    for (const { input, expected } of cases) {
      expect(interactiveTerminalFailure(input)).toBe(expected);
    }
  });

  it('gives interactive PTY users an exact TERM recovery hint', () => {
    expect(dumbTerminalMessage('chat')).toBe(DUMB_TERMINAL_HINT);
  });

  it('keeps the non-interactive fallback when one applies', () => {
    expect(
      dumbTerminalMessage('chat', { nonInteractiveFallback: '`texra run`' }),
    ).toBe(
      `${DUMB_TERMINAL_HINT} For non-interactive runs, use \`texra run\`.`,
    );
  });

  it('formats the classified failure without repeating the predicate', () => {
    expect(
      formatInteractiveTerminalFailure('headless', {
        headlessMessage: 'headless copy',
        dumbTerminalCommand: 'chat',
      }),
    ).toBe('headless copy');
    expect(
      formatInteractiveTerminalFailure('dumb-terminal', {
        headlessMessage: 'headless copy',
        dumbTerminalCommand: 'chat',
        dumbTerminalOptions: { nonInteractiveFallback: '`texra run`' },
      }),
    ).toBe(
      `${DUMB_TERMINAL_HINT} For non-interactive runs, use \`texra run\`.`,
    );
  });
});
