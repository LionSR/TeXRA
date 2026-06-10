import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installTerminalRestoreOnExit,
  supportsTerminalJobControl,
  tuiInputModeRestoreSequence,
} from '@cli/chat/tui/terminalCleanup';

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('supportsTerminalJobControl', () => {
  it('disables Ctrl-Z suspend on Windows where SIGSTOP is unsupported', () => {
    expect(supportsTerminalJobControl('win32')).toBe(false);
    expect(supportsTerminalJobControl('darwin')).toBe(true);
    expect(supportsTerminalJobControl('linux')).toBe(true);
  });
});

describe('installTerminalRestoreOnExit', () => {
  it('registers a process exit listener and removes it on dispose', () => {
    const on = vi.spyOn(process, 'on').mockReturnThis();
    const off = vi.spyOn(process, 'off').mockReturnThis();

    const dispose = installTerminalRestoreOnExit();
    const listener = on.mock.calls[0]?.[1];

    expect(on).toHaveBeenCalledWith('exit', expect.any(Function));
    dispose();
    expect(off).toHaveBeenCalledWith('exit', listener);
  });

  it('tolerates double dispose', () => {
    vi.spyOn(process, 'on').mockReturnThis();
    const off = vi.spyOn(process, 'off').mockReturnThis();
    const dispose = installTerminalRestoreOnExit();
    dispose();
    dispose();
    expect(off).toHaveBeenCalledTimes(2);
  });
});
