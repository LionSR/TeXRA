import { writeSync } from 'node:fs';

import { kittyFlags } from 'ink';

import { cliEnvValue } from '../runtime/cliContext';

// Undo exactly the input/display modes the TUI turns on: mouse tracking
// (1000/1003/1006), the kitty keyboard stack (<u), bracketed paste (2004), and
// cursor visibility (25h). The TUI deliberately never enters the alternate
// screen (?1049h is never sent), so it must NOT emit ?1049l here: terminals that
// honor rmcup restore the primary screen grid to the snapshot from the last
// smcup — which, with no smcup this session, is a stale grid that wipes whatever
// was just printed at the bottom (notably the "texra resume …" hint). tmux
// masks this by ignoring an unmatched rmcup; Ghostty/iTerm2/Terminal.app do not.
const RESET_TERMINAL_MODES = '\x1b[?1000;1003;1006l\x1b[<u\x1b[?2004l\x1b[?25h';
const CLEAR_ITERM_PROGRESS = '\x1b]9;4;0\x07';
// Re-arm the emulator-side input modes after a SIGCONT resume: kitty
// disambiguate push, bracketed paste, and cursor hide. The tty driver state
// (raw mode) is restored separately — the shell only restores the termios
// snapshot it took at suspend, never these escape-sequence modes, which
// cleanupTerminalModes popped before stopping. The push value comes from
// Ink's own flag table and must match the `flags` runChatTui passes to
// `render()`; bracketed paste is re-enabled unconditionally because Ink's
// `usePaste` enables it unconditionally too — this only restores Ink's state.
// Mouse modes are reset defensively above, but not re-armed because this TUI
// does not enable mouse input. Add them here only if a future mouse path turns
// them on during normal render.
const KITTY_PUSH_DISAMBIGUATE = `\x1b[>${kittyFlags.disambiguateEscapeCodes}u`;
const REARM_INPUT_MODES = '\x1b[?2004h\x1b[?25l';
// Clear visible screen + erase scrollback + home cursor. Required by
// `/clear` since the TUI no longer uses the alternate screen, so prior
// `<Static>` transcript lines persist in the primary-buffer scrollback.
const CLEAR_SCREEN_AND_SCROLLBACK = '\x1b[2J\x1b[3J\x1b[H';
const CLEAR_VISIBLE_SCREEN = '\x1b[2J\x1b[H';

// The terminal may be gone (exit paths, a suspend, a closed window) and no
// caller can surface a failed write usefully, so every terminal-control write
// is best-effort. Synchronous, so it also works from the process `exit` hook.
export function writeTerminalSequence(sequence: string): void {
  try {
    writeSync(1, sequence);
  } catch {
    // Nothing to do.
  }
}

export function supportsTerminalJobControl(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

function cleanupTerminalModes(): void {
  // TERM_PROGRAM is fixed for the process, so the writer owns the emulator
  // check rather than having it threaded through the exit controller.
  writeTerminalSequence(
    cliEnvValue('TERM_PROGRAM') === 'iTerm.app'
      ? `${RESET_TERMINAL_MODES}${CLEAR_ITERM_PROGRESS}`
      : RESET_TERMINAL_MODES,
  );
}

/** The live terminal title the TUI projects while it owns the terminal. */
interface TuiTerminalTitle {
  /** Show the idle title and stop projecting live state. */
  readonly suspend: () => void;
  /** Project live state again. */
  readonly resume: () => void;
  /** Show the idle title and stop for good. */
  readonly dispose: () => void;
}

/** The mounted TUI's hold on the terminal: raw mode, emulator modes, title. */
export interface TuiTerminal {
  /** Hand the terminal to the shell before a job-control stop. */
  readonly suspend: () => void;
  /** Take it back after SIGCONT; the caller repaints. */
  readonly resume: () => void;
  /** Restore the terminal for good. Idempotent and synchronous. */
  readonly release: () => void;
}

/**
 * The one owner of the terminal state the TUI changes. Every restore writes
 * the idle title first, then resets the modes, synchronously. `release` is
 * also the last-resort `exit` hook: an uncaught exception or a stray
 * `process.exit` must not strand the user's shell with mouse reporting, kitty
 * keyboard or bracketed paste on and the cursor hidden.
 */
export function acquireTuiTerminal(options: {
  readonly kittyKeyboard: boolean;
  readonly title: TuiTerminalTitle;
}): TuiTerminal {
  const { title } = options;
  let released = false;
  const setRawMode = (raw: boolean): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(raw);
  };
  const release = (): void => {
    if (released) return;
    released = true;
    process.off('exit', release);
    title.dispose();
    cleanupTerminalModes();
  };
  process.on('exit', release);
  return {
    suspend: () => {
      title.suspend();
      cleanupTerminalModes();
      setRawMode(false);
    },
    // The shell restores only the termios snapshot from suspend time
    // (non-raw); the emulator-side modes were popped outright, so re-arm both.
    resume: () => {
      setRawMode(true);
      writeTerminalSequence(
        `${options.kittyKeyboard ? KITTY_PUSH_DISAMBIGUATE : ''}${REARM_INPUT_MODES}`,
      );
      title.resume();
    },
    release,
  };
}

export function clearTerminalScrollback(): void {
  writeTerminalSequence(CLEAR_SCREEN_AND_SCROLLBACK);
}

export function clearTerminalVisibleScreen(): void {
  writeTerminalSequence(CLEAR_VISIBLE_SCREEN);
}
