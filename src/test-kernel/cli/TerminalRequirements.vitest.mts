import { describe, expect, it } from 'vitest';

import {
  dumbTerminalMessage,
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '@cli/runtime/terminalRequirements';

describe('terminal requirement diagnostics', () => {
  it('classifies interactive terminal failures once for CLI entry points', () => {
    expect(
      interactiveTerminalFailure({
        mode: 'headless',
        stdoutIsTty: true,
        termIsDumb: false,
      }),
    ).toBe('headless');
    expect(
      interactiveTerminalFailure({
        mode: 'interactive',
        stdoutIsTty: false,
        termIsDumb: false,
      }),
    ).toBe('headless');
    expect(
      interactiveTerminalFailure({
        mode: 'interactive',
        stdoutIsTty: true,
        termIsDumb: true,
      }),
    ).toBe('dumb-terminal');
    expect(
      interactiveTerminalFailure({
        mode: 'interactive',
        stdoutIsTty: true,
        termIsDumb: false,
      }),
    ).toBeUndefined();
  });

  it('gives interactive PTY users an exact TERM recovery hint', () => {
    expect(dumbTerminalMessage('chat')).toBe(
      'texra chat needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`.',
    );
  });

  it('keeps the non-interactive fallback when one applies', () => {
    expect(
      dumbTerminalMessage('chat', { nonInteractiveFallback: '`texra run`' }),
    ).toBe(
      'texra chat needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`. For non-interactive runs, use `texra run`.',
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
      'texra chat needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`. For non-interactive runs, use `texra run`.',
    );
  });
});
