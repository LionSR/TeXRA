import { writeSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import {
  installTerminalRestoreOnExit,
  setTerminalTitle,
  supportsTerminalJobControl,
  terminalTitleText,
  tuiInputModeRestoreSequence,
} from '@cli/chat/tui/terminalCleanup';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  writeSync: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  // `writeSync` is a vi.fn() created inside the vi.mock() factory above, not
  // a vi.spyOn() wrapping a real implementation — restoreAllMocks() has no
  // "original" to restore it to and leaves its call history untouched, so
  // clear it explicitly or a later test's `not.toHaveBeenCalled()` sees an
  // earlier test's call.
  vi.mocked(writeSync).mockClear();
  terminalCapabilities.set({
    kittyKeyboard: false,
    graphemeClusters: false,
    bracketedPaste: false,
    oscColorReports: false,
    discovered: false,
  });
});

describe('terminalTitleText', () => {
  it('names the tab after the project folder', () => {
    expect(terminalTitleText('/Users/ray/projects/coauthor')).toBe(
      'TeXRA — coauthor',
    );
  });

  it('falls back to the bare brand name at the filesystem root', () => {
    expect(terminalTitleText('/')).toBe('TeXRA');
  });

  it('strips control characters out of a hostile folder name', () => {
    expect(terminalTitleText('/tmp/evil\x07\x1b]0;pwned\x07')).toBe(
      'TeXRA — evil]0;pwned',
    );
  });
});

describe('setTerminalTitle', () => {
  it('writes an OSC 0 title sequence on an OSC-capable terminal', () => {
    terminalCapabilities.set({
      kittyKeyboard: false,
      graphemeClusters: false,
      bracketedPaste: false,
      oscColorReports: true,
      discovered: true,
    });

    setTerminalTitle('/Users/ray/projects/coauthor');

    expect(writeSync).toHaveBeenCalledWith(1, '\x1b]0;TeXRA — coauthor\x07');
  });

  it('leaves the title alone on a terminal that never acknowledged OSC support', () => {
    terminalCapabilities.set({
      kittyKeyboard: false,
      graphemeClusters: false,
      bracketedPaste: false,
      oscColorReports: false,
      discovered: true,
    });

    setTerminalTitle('/Users/ray/projects/coauthor');

    expect(writeSync).not.toHaveBeenCalled();
  });
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
