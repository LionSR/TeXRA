// Terminal notification dispatcher per
// docs/prd/cli-tui-ink/10-architecture.md (Terminal notifications).
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
// docs/prd/cli-tui-ink/30-reference.md#16-risks (R9).

import { writeRawStdout } from '@cli/runtime/logSinks';
import { terminalCapabilities } from '../state/terminalCapabilities';

export type NotificationKind = 'agentFinished' | 'approvalNeeded';

export interface NotifyInit {
  readonly kind: NotificationKind;
  readonly title?: string;
  readonly body?: string;
}

const BEL = '';
const ESC = '';

function osc9(message: string): string {
  return `${ESC}]9;${message}${BEL}`;
}

function osc99(message: string): string {
  // OSC 99 ; <kv> ; <body> ST — Kitty's notification protocol.
  return `${ESC}]99;;${message}${ESC}\\`;
}

export function notify(init: NotifyInit): void {
  const caps = terminalCapabilities.get();
  const message = formatMessage(init);
  if (caps.oscColorReports) {
    // OSC-capable terminal — use the structured notification protocol.
    writeRawStdout(osc99(message));
    writeRawStdout(osc9(message));
    return;
  }
  writeRawStdout(BEL);
}

function formatMessage(init: NotifyInit): string {
  if (init.title && init.body) return `${init.title}: ${init.body}`;
  return init.title ?? init.body ?? defaultMessageFor(init.kind);
}

function defaultMessageFor(kind: NotificationKind): string {
  switch (kind) {
    case 'agentFinished':
      return 'TeXRA agent finished';
    case 'approvalNeeded':
      return 'TeXRA approval needed';
  }
}
