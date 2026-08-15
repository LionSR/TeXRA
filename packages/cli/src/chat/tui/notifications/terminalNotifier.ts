// Terminal notification dispatcher per
// docs/prds/cli-tui-ink/2026-05-14-10-architecture.md (Terminal notifications).
//
// Phase 1 ships `agentFinished` + `approvalNeeded`; progress (OSC 9;4) lands
// in Phase 4 when long-running activity surfaces.
//
// Each emission is capability-gated by the `terminalCapabilities` signal:
// terminals that didn't acknowledge OSC support during DA1 discovery get the
// fallback `BEL` only, not full OSC sequences (silent terminals on macOS
// Terminal in particular gain nothing from OSC 9 / 99 and may even garble).
//
// Multiplexer-aware DCS wrapping for tmux/screen is deferred per
// docs/prds/cli-tui-ink/2026-05-14-30-reference.md#16-risks (R9).

import { writeRawStdout } from '@cli/runtime/logSinks';
import { terminalCapabilities } from '../state/terminalCapabilities';

type NotificationKind =
  'agentFinished' | 'approvalNeeded' | 'credentialSwitched';

const BEL = '';
const ESC = '';

function osc9(message: string): string {
  return `${ESC}]9;${message}${BEL}`;
}

function osc99(message: string): string {
  // OSC 99 ; <kv> ; <body> ST — Kitty's notification protocol.
  return `${ESC}]99;;${message}${ESC}\\`;
}

export function notify(kind: NotificationKind): void {
  const caps = terminalCapabilities.get();
  const message = defaultMessageFor(kind);
  if (caps.oscColorReports) {
    // OSC-capable terminal — use the structured notification protocol.
    writeRawStdout(osc99(message));
    writeRawStdout(osc9(message));
    return;
  }
  writeRawStdout(BEL);
}

function defaultMessageFor(kind: NotificationKind): string {
  switch (kind) {
    case 'agentFinished':
      return 'TeXRA agent finished';
    case 'approvalNeeded':
      return 'TeXRA approval needed';
    case 'credentialSwitched':
      return 'TeXRA switched to your own API key';
  }
}
