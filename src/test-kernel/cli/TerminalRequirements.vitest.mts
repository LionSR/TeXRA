import { describe, expect, it } from 'vitest';

import { dumbTerminalMessage } from '@cli/runtime/terminalRequirements';

describe('terminal requirement diagnostics', () => {
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
});
