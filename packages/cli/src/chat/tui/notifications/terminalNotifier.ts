// Terminal notification dispatcher.
//
// Emits `agentFinished` and `approvalNeeded`. Progress (OSC 9;4) is not
// emitted: no long-running activity surfaces in the TUI yet.
//
// Each emission is capability-gated by the `terminalCapabilities` signal:
// terminals that didn't acknowledge OSC support during DA1 discovery get the
// fallback `BEL` only, not full OSC sequences (silent terminals on macOS
// Terminal in particular gain nothing from OSC 9 / 99 and may even garble).
//
// The sequences are not DCS-wrapped for tmux or screen, so a multiplexer
// that does not pass OSC through drops them.

import { ANSI_BEL, osc } from '@cli/runtime/terminal/ansiEscapes';
import { writeTerminalSequence } from '@cli/tui/terminalCleanup';
import { terminalCapabilities } from '../state/terminalCapabilities';

type NotificationKind = 'agentFinished' | 'approvalNeeded';

/**
 * Write OSC sequences when capability discovery admitted OSC; the one gate
 * for every OSC the TUI emits. Returns whether anything was written.
 */
export function writeOsc(...sequences: readonly string[]): boolean {
  if (!terminalCapabilities.get().oscColorReports) return false;
  writeTerminalSequence(sequences.join(''));
  return true;
}

export function notify(kind: NotificationKind): void {
  const message = defaultMessageFor(kind);
  // OSC 99 is Kitty's notification protocol (ST-terminated); OSC 9 is the
  // iTerm2-family one. A terminal without OSC gets the plain BEL.
  if (!writeOsc(osc(`99;;${message}`, 'st'), osc(`9;${message}`))) {
    writeTerminalSequence(ANSI_BEL);
  }
}

function defaultMessageFor(kind: NotificationKind): string {
  switch (kind) {
    case 'agentFinished':
      return 'TeXRA agent finished';
    case 'approvalNeeded':
      return 'TeXRA approval needed';
  }
}
