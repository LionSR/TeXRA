import { writeSync } from 'node:fs';

const ENTER_TERMINAL_FULL_SCREEN = '\x1b[?1049h\x1b[2J\x1b[H';
const RESET_TERMINAL_MODES =
  '\x1b[?1000;1003;1006l\x1b[?1049l\x1b[<u\x1b[?2004l\x1b[?25h';
const CLEAR_ITERM_PROGRESS = '\x1b]9;4;0\x07';

export interface CleanupTerminalModesOptions {
  readonly clearItermProgress?: boolean;
}

export function enterTerminalFullScreen(): void {
  try {
    writeSync(1, ENTER_TERMINAL_FULL_SCREEN);
  } catch {
    // Startup cannot surface terminal-mode failures usefully; Ink will still
    // render in the primary buffer.
  }
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
