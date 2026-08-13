import { writeSync } from 'node:fs';

import { kittyFlags } from 'ink';

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
interface CleanupTerminalModesOptions {
  readonly clearItermProgress?: boolean;
}

// The terminal may be gone (exit paths, a suspend, a closed window) and no
// caller can surface a failed restore usefully, so every mode write is
// best-effort.
function writeTerminalSequence(sequence: string): void {
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

export function cleanupTerminalModes(
  options: CleanupTerminalModesOptions = {},
): void {
  writeTerminalSequence(
    options.clearItermProgress
      ? `${RESET_TERMINAL_MODES}${CLEAR_ITERM_PROGRESS}`
      : RESET_TERMINAL_MODES,
  );
}

/**
 * Last-resort terminal restore: an uncaught exception (or a stray
 * `process.exit` outside the TUI's own teardown) must not strand the user's
 * shell with mouse reporting / kitty keyboard / bracketed paste on and the
 * cursor hidden. The `exit` event fires on every non-signal death, the writes
 * are synchronous, and re-emitting the resets after an orderly
 * `cleanupTerminalModes` is harmless — so install once while the TUI is
 * mounted and dispose with the other subscriptions.
 */
export function installTerminalRestoreOnExit(
  options: CleanupTerminalModesOptions = {},
): () => void {
  const onExit = (): void => cleanupTerminalModes(options);
  process.on('exit', onExit);
  return () => {
    process.off('exit', onExit);
  };
}

export function tuiInputModeRestoreSequence(options: {
  readonly kittyKeyboard: boolean;
}): string {
  return `${options.kittyKeyboard ? KITTY_PUSH_DISAMBIGUATE : ''}${REARM_INPUT_MODES}`;
}

/** Re-enable the input modes the TUI relies on after a SIGCONT resume. */
export function restoreTuiInputModes(options: {
  readonly kittyKeyboard: boolean;
}): void {
  writeTerminalSequence(tuiInputModeRestoreSequence(options));
}

export function clearTerminalScrollback(): void {
  writeTerminalSequence(CLEAR_SCREEN_AND_SCROLLBACK);
}

export function clearTerminalVisibleScreen(): void {
  writeTerminalSequence(CLEAR_VISIBLE_SCREEN);
}
