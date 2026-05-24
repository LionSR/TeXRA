// Pure viewport math for the live transcript region. Finalized entries are
// owned by `<Static>` scrollback; this module only sizes the in-flight tail.

import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import { LIVE_TAIL_ROWS } from './TranscriptEntry';
import { toolUseDisplayLines } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

function estimateWrappedRows(text: string, width: number): number {
  const cols = Math.max(1, width);
  const lines = text.length > 0 ? text.split('\n') : [''];
  return lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / cols)),
    0,
  );
}

export function estimateTranscriptEntryRows(
  entry: ConversationEntry,
  width = 80,
): number {
  if (entry.role === 'tool' && entry.toolUse) {
    return toolUseDisplayLines(entry.toolUse).length + 1;
  }
  if (entry.role === 'process' && entry.process) {
    return Math.max(1, completedProcessDisplayLines(entry.process).length) + 1;
  }
  if (entry.role === 'assistant') {
    const rendered = renderAnsiMarkdown(entry.text, { width });
    return Math.max(1, rendered.split('\n').length) + 1;
  }
  // User / error rows render without a trailing margin (compact mode) so
  // chat-heavy sessions don't burn half the viewport on blank gaps. Their
  // box uses `paddingX={1}` (2 cols) and a 2-col prefix (`› ` / `! `), so
  // long text wraps to `width - 4` — keep the estimate in sync.
  if (entry.role === 'user' || entry.role === 'error') {
    return estimateWrappedRows(entry.text, Math.max(1, width - 4));
  }

  return estimateWrappedRows(entry.text, width) + 1;
}

function estimatePendingEntryRows(
  entry: ConversationEntry,
  width = 80,
): number {
  // Live assistant text streams as raw wrapped lines (no Markdown parse)
  // and has no trailing margin row. Cap at the tail LiveTranscriptEntry
  // actually paints so a long reply doesn't over-reserve rows and crowd
  // out co-pending tool rows.
  if (entry.role === 'assistant') {
    return Math.min(LIVE_TAIL_ROWS, estimateWrappedRows(entry.text, width));
  }
  return estimateTranscriptEntryRows(entry, width);
}

export interface PendingEntrySelection {
  readonly entries: readonly ConversationEntry[];
  readonly rowLimits: ReadonlyMap<string, number>;
  readonly usedRows: number;
}

// Pick the newest live entries that fit in `maxRows`. Finalized entries do
// not pass through this path; they are printed once by `<Static>` so ordinary
// terminal scrollback is the source of truth for the conversation history.
export function selectPendingEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width = 80,
): PendingEntrySelection {
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { entries: [], rowLimits: new Map(), usedRows: 0 };
  }

  const selected: ConversationEntry[] = [];
  const rowLimits = new Map<string, number>();
  let usedRows = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const entryRows = estimatePendingEntryRows(entry, width);
    if (usedRows + entryRows > maxRows) {
      if (
        selected.length === 0 &&
        (entry.role === 'assistant' || entry.role === 'tool')
      ) {
        selected.unshift(entry);
        rowLimits.set(entry.id, maxRows);
        usedRows = maxRows;
      }
      break;
    }
    selected.unshift(entry);
    usedRows += entryRows;
  }
  return { entries: selected, rowLimits, usedRows };
}
