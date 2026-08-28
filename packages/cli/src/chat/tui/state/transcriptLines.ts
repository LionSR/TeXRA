// Flatten a stream's conversation entries into full-fidelity plain-text
// display lines. Unlike the finalized scrollback and the live region, this
// renders every tool-output line.

import type { TranscriptRow } from '@shared/transcript';
import type { ExecutionLabels } from '@shared/tools/executionsDisplay';

import { isRenderableTranscriptEntry } from '../panes/transcriptEntries';
import { fullTranscriptEntryLayout } from '../panes/transcriptEntryLayout';
import type { StreamSlice } from './cliState';

// Wrapped-line memo keyed by the immutable entry object. Entries are replaced
// (never mutated in place) when their content changes, so a hit is always
// current, and the WeakMap needs no eviction: a replaced/discarded entry takes
// its slot with it. One slot per entry suffices — the sole caller
// (`TranscriptReader`) lays every entry out at one width under one labels
// snapshot per frame, so only a resize or roster change misses, and then
// exactly once per entry.
const EMPTY_EXECUTION_LABELS: ExecutionLabels = new Map();

interface EntryLinesMemo {
  readonly cols: number;
  readonly labels: ExecutionLabels;
  readonly lines: readonly string[];
}

const entryLinesCache = new WeakMap<TranscriptRow, EntryLinesMemo>();

function transcriptEntryLines(
  entry: TranscriptRow,
  cols: number,
  executionLabels: ExecutionLabels,
): readonly string[] {
  const memo = entryLinesCache.get(entry);
  if (memo && memo.cols === cols && memo.labels === executionLabels) {
    return memo.lines;
  }
  const lines = fullTranscriptEntryLayout(entry, cols, executionLabels).lines;
  entryLinesCache.set(entry, { cols, labels: executionLabels, lines });
  return lines;
}

function isCompactToolEntry(
  entry: TranscriptRow,
  lines: readonly string[],
): boolean {
  return entry.kind === 'tool' && lines.length <= 1;
}

function isPromptToToolTurn(
  previousEntry: TranscriptRow,
  nextEntry: TranscriptRow,
): boolean {
  return previousEntry.kind === 'user' && nextEntry.kind === 'tool';
}

function shouldSeparateEntries({
  previousEntry,
  previousLines,
  nextEntry,
  nextLines,
}: {
  readonly previousEntry: TranscriptRow | undefined;
  readonly previousLines: readonly string[];
  readonly nextEntry: TranscriptRow;
  readonly nextLines: readonly string[];
}): boolean {
  if (!previousEntry) return false;
  if (isPromptToToolTurn(previousEntry, nextEntry)) return false;
  return !(
    isCompactToolEntry(previousEntry, previousLines) &&
    isCompactToolEntry(nextEntry, nextLines)
  );
}

/** Render the active slice into a flat line array with blank separators between
 *  substantial entries. Tool execution rows stay attached to the prompt or
 *  adjacent compact tools so command-heavy traces do not waste vertical space. */
export function transcriptToLines(
  slice: StreamSlice | undefined,
  cols: number,
  executionLabels: ExecutionLabels = EMPTY_EXECUTION_LABELS,
): readonly string[] {
  if (!slice) return [];
  const out: string[] = [];
  let previousEntry: TranscriptRow | undefined;
  let previousLines: readonly string[] = [];
  for (const entry of slice.entries) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    const lines = transcriptEntryLines(entry, cols, executionLabels);
    if (lines.length === 0) continue;
    if (
      out.length > 0 &&
      shouldSeparateEntries({
        previousEntry,
        previousLines,
        nextEntry: entry,
        nextLines: lines,
      })
    ) {
      out.push('');
    }
    out.push(...lines);
    previousEntry = entry;
    previousLines = lines;
  }
  return out;
}
