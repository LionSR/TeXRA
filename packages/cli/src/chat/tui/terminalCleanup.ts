import { writeSync } from 'node:fs';
import { basename } from 'node:path';

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
const OSC_TITLE_TERMINATOR = '\x07';

/** Directory names can contain characters that would prematurely terminate
 *  the OSC string (a stray BEL/ESC) or that some terminals in 8-bit mode
 *  still interpret as escape-sequence introducers (the C1 range, e.g. 0x9d
 *  as an 8-bit OSC); strip both C0 and C1 controls so a weird folder name
 *  can't inject terminal escape sequences into the title. */
function sanitizeTitleSegment(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping C0/C1 controls
  return text.replaceAll(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * "TeXRA" alone when the cwd has no meaningful basename (e.g. filesystem
 * root, where `path.basename` returns `''`), else "TeXRA — <project folder>"
 * so a user running several sessions across different projects — the common
 * case here — can tell tabs apart at a glance instead of every tab reading
 * the launcher binary's own name (e.g. a local dev symlink like
 * `texra-local`).
 */
export function terminalTitleText(cwd: string): string {
  const project = sanitizeTitleSegment(basename(cwd));
  return project ? `TeXRA — ${project}` : 'TeXRA';
}

export interface CleanupTerminalModesOptions {
  readonly clearItermProgress?: boolean;
}

export function supportsTerminalJobControl(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

export function cleanupTerminalModes(
  options: CleanupTerminalModesOptions = {},
): void {
  try {
    writeSync(1, RESET_TERMINAL_MODES);
    if (options.clearItermProgress) writeSync(1, CLEAR_ITERM_PROGRESS);
  } catch {
    // Exit paths cannot surface cleanup failures usefully.
  }
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
  try {
    writeSync(1, tuiInputModeRestoreSequence(options));
  } catch {
    // The terminal may have gone away across the suspend; nothing to do.
  }
}

export function clearTerminalScrollback(): void {
  try {
    writeSync(1, CLEAR_SCREEN_AND_SCROLLBACK);
  } catch {
    // The terminal may have been closed mid-clear; nothing to do.
  }
}

export function clearTerminalVisibleScreen(): void {
  try {
    writeSync(1, CLEAR_VISIBLE_SCREEN);
  } catch {
    // The terminal may have been closed mid-clear; nothing to do.
  }
}

/**
 * Set the terminal tab/window title via OSC 0. Unlike the DA1-gated
 * capability queries elsewhere in the TUI, this needs no negotiation: OSC 0
 * is a one-way "set" with no reply to wait for, and terminals that don't
 * recognize it just ignore it.
 */
export function setTerminalTitle(cwd: string): void {
  try {
    writeSync(1, `\x1b]0;${terminalTitleText(cwd)}${OSC_TITLE_TERMINATOR}`);
  } catch {
    // The tab title is cosmetic; a write failure here isn't actionable.
  }
}
