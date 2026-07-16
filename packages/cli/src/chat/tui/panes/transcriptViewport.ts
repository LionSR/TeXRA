// Pure viewport math for bounded pending transcript panes.

import {
  transcriptEntryLayout,
  transcriptEntryLayoutRows,
} from './transcriptEntryLayout';
import { isRenderableTranscriptEntry } from './transcriptEntries';
import type { ConversationEntry } from '../state/cliState';

const FAILED_ENTRY_ESTIMATE_ROWS = 1;

function estimateEntryRows(computeRows: () => number): number {
  try {
    return computeRows();
  } catch {
    return FAILED_ENTRY_ESTIMATE_ROWS;
  }
}

export function estimateTranscriptEntryRows(
  entry: ConversationEntry,
  width?: number,
): number {
  return estimateEntryRows(() =>
    transcriptEntryLayoutRows(transcriptEntryLayout(entry, { width })),
  );
}

function estimateLiveTranscriptEntryRows(
  entry: ConversationEntry,
  width?: number,
): number {
  // Live mode captures the pending-pane paint contract: assistant text uses
  // its capped raw tail, while rich tool/process rows keep one descriptor
  // line per terminal row instead of being reflowed like plain projections.
  return estimateEntryRows(() =>
    transcriptEntryLayoutRows(
      transcriptEntryLayout(entry, { mode: 'live', width }),
    ),
  );
}

export interface TranscriptEntrySelection {
  readonly entries: readonly ConversationEntry[];
  readonly rowLimits: ReadonlyMap<string, number>;
  readonly usedRows: number;
}

// Pick the newest entries that fit in `maxRows`. Conversation live mode passes
// pending rows; finalized history is owned by Static/native scrollback.
export function selectTranscriptEntriesForViewport(
  entries: readonly ConversationEntry[],
  maxRows: number,
  width?: number,
): TranscriptEntrySelection {
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { entries: [], rowLimits: new Map(), usedRows: 0 };
  }

  const selected: ConversationEntry[] = [];
  const rowLimits = new Map<string, number>();
  let usedRows = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRenderableTranscriptEntry(entry)) continue;
    const entryRows = estimateLiveTranscriptEntryRows(entry, width);
    if (usedRows + entryRows > maxRows) {
      if (selected.length === 0) {
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
