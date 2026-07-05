// Pure viewport math for bounded pending transcript panes.

import { renderAnsiMarkdown } from '../render/ansiMarkdown';
import { completedProcessDisplayLines } from '../state/completedProcessTranscript';
import {
  ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS,
  LIVE_TAIL_ROWS,
  PROCESS_ENTRY_MARGIN_BOTTOM_ROWS,
  USER_ENTRY_MARGIN_BOTTOM_ROWS,
  USER_ENTRY_MARGIN_TOP_ROWS,
  liveAssistantDisplayLines,
} from './TranscriptEntry';
import {
  isInquiryContinuationText,
  isRenderableTranscriptEntry,
} from './transcriptEntries';
import { toolUseDisplayLines } from './toolRenderers';
import type { ConversationEntry } from '../state/cliState';

const FAILED_ENTRY_ESTIMATE_ROWS = 1;

function estimateEntryRows(computeRows: () => number): number {
  try {
    return computeRows();
  } catch {
    return FAILED_ENTRY_ESTIMATE_ROWS;
  }
}

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
  if (entry.role === 'tool') {
    const toolUse = entry.toolUse;
    return estimateEntryRows(() => {
      const lines = toolUseDisplayLines(toolUse);
      return lines.length + (lines.length > 1 ? 1 : 0);
    });
  }
  if (entry.role === 'process') {
    const process = entry.process;
    return estimateEntryRows(() => {
      return (
        Math.max(1, completedProcessDisplayLines(process).length) +
        PROCESS_ENTRY_MARGIN_BOTTOM_ROWS
      );
    });
  }
  if (entry.role === 'assistant') {
    return estimateEntryRows(() => {
      const rendered = renderAnsiMarkdown(entry.text, { width });
      return (
        Math.max(1, rendered.split('\n').length) +
        ASSISTANT_ENTRY_MARGIN_BOTTOM_ROWS
      );
    });
  }
  if (entry.role === 'user' || entry.role === 'error') {
    // Both roles render inside a paddingX={1} box plus a 2-col prefix
    // (`› ` / `! `), so text wraps to `width - 4`.
    const textRows = estimateWrappedRows(entry.text, Math.max(1, width - 4));
    const marginRows =
      entry.role === 'user' && !isInquiryContinuationText(entry.text)
        ? USER_ENTRY_MARGIN_TOP_ROWS + USER_ENTRY_MARGIN_BOTTOM_ROWS
        : 0;
    return textRows + marginRows;
  }

  return estimateWrappedRows(entry.text, width) + 1;
}

function estimateLiveTranscriptEntryRows(
  entry: ConversationEntry,
  width = 80,
): number {
  // Live assistant text streams as raw wrapped lines (no Markdown parse)
  // and has no trailing margin row. Pre-slice to the same tail window
  // LiveTranscriptEntry paints, then cap at LIVE_TAIL_ROWS — so a
  // multi-MB reply never gets split in full just for an estimate that
  // discards everything above the tail.
  if (entry.role === 'assistant') {
    return estimateEntryRows(() => {
      const cols = Math.max(1, width);
      return liveAssistantDisplayLines({
        rows: LIVE_TAIL_ROWS,
        text: entry.text,
        width: cols,
      }).length;
    });
  }
  return estimateTranscriptEntryRows(entry, width);
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
  width = 80,
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
