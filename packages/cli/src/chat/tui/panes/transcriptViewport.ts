// Pure viewport math for bounded pending transcript panes.

import type { TranscriptRow } from '@ui/transcript';
import {
  transcriptEntryLayout,
  transcriptEntryLayoutRows,
} from './transcriptEntryLayout';
import { isRenderableTranscriptEntry } from './transcriptEntries';

const FAILED_ENTRY_ESTIMATE_ROWS = 1;

// Live mode captures the pending-pane paint contract: assistant text uses its
// capped raw tail, while rich tool rows keep one descriptor line per terminal
// row instead of being reflowed like plain projections.
export function estimateLiveTranscriptEntryRows(
  entry: TranscriptRow,
  width?: number,
): number {
  try {
    return transcriptEntryLayoutRows(
      transcriptEntryLayout(entry, { mode: 'live', width }),
    );
  } catch {
    // The entry itself renders through the same live layout inside its
    // `EntryErrorBoundary`, so the throw surfaces there as the inline failure
    // marker -- one row, which is what this reserves.
    return FAILED_ENTRY_ESTIMATE_ROWS;
  }
}

interface TranscriptEntrySelection {
  readonly entries: readonly TranscriptRow[];
  readonly rowLimits: ReadonlyMap<string, number>;
  readonly usedRows: number;
}

// Pick the newest entries that fit in `maxRows`. Conversation live mode passes
// pending rows; finalized history is owned by Static/native scrollback.
export function selectTranscriptEntriesForViewport(
  entries: readonly TranscriptRow[],
  maxRows: number,
  width?: number,
): TranscriptEntrySelection {
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    return { entries: [], rowLimits: new Map(), usedRows: 0 };
  }

  const selected: TranscriptRow[] = [];
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
