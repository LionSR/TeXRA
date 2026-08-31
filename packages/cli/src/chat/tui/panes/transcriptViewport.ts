// Pure viewport math for bounded pending transcript panes.

import { createLog } from '@logger/logUtils';
import type { TranscriptRow } from '@shared/transcript';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';
import { createBoundedIdSet } from '@utils/core/boundedIdSet';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  transcriptEntryLayout,
  transcriptEntryLayoutRows,
} from './transcriptEntryLayout';
import { isRenderableTranscriptEntry } from './transcriptEntries';

const FAILED_ENTRY_ESTIMATE_ROWS = 1;
const BROKEN_ENTRY_REPORT_CAP = 1000;
const log = createLog('transcriptViewport');
/** Entry ids already reported, so a persistently-throwing entry is logged once
 *  instead of once per stream-sync tick (the estimate path runs per frame). */
const brokenEntryIdsReported = createBoundedIdSet(BROKEN_ENTRY_REPORT_CAP);

// Live mode captures the pending-pane paint contract: assistant text uses its
// capped raw tail, while rich tool rows keep one descriptor line per terminal
// row instead of being reflowed like plain projections.
export function estimateLiveTranscriptEntryRows(
  entry: TranscriptRow,
  width?: number,
  executionLabels?: ExecutionLabels,
): number {
  try {
    return transcriptEntryLayoutRows(
      transcriptEntryLayout(entry, { executionLabels, mode: 'live', width }),
    );
  } catch (error) {
    if (!brokenEntryIdsReported.has(entry.id)) {
      brokenEntryIdsReported.add(entry.id);
      log.warn(
        `Failed to estimate rows for ${entry.kind} row ${entry.id}; assuming ${FAILED_ENTRY_ESTIMATE_ROWS}: ${toErrorMessage(error)}`,
      );
    }
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
  executionLabels?: ExecutionLabels,
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
    const entryRows = estimateLiveTranscriptEntryRows(
      entry,
      width,
      executionLabels,
    );
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
