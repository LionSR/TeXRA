import { describe, expect, it } from 'vitest';

import {
  installTerminalRestoreOnExit,
  tuiInputModeRestoreSequence,
} from '@cli/chat/tui/terminalCleanup';

describe('tuiInputModeRestoreSequence', () => {
  it('re-arms bracketed paste and cursor hide after a SIGCONT resume', () => {
    expect(tuiInputModeRestoreSequence({ kittyKeyboard: false })).toBe(
      '\x1b[?2004h\x1b[?25l',
    );
  });

  it("re-pushes Ink's kitty disambiguate flag on kitty terminals", () => {
    expect(tuiInputModeRestoreSequence({ kittyKeyboard: true })).toBe(
      '\x1b[>1u\x1b[?2004h\x1b[?25l',
    );
  });
});

describe('installTerminalRestoreOnExit', () => {
  it('registers a process exit listener and removes it on dispose', () => {
    const before = process.listenerCount('exit');
    const dispose = installTerminalRestoreOnExit();
    expect(process.listenerCount('exit')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('tolerates double dispose', () => {
    const before = process.listenerCount('exit');
    const dispose = installTerminalRestoreOnExit();
    dispose();
    dispose();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
