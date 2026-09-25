// Flatten a stream's conversation entries into full-fidelity plain-text
// display lines. Unlike the finalized scrollback and the live region, this
// renders every tool-output line.

import type { TranscriptRow } from '@ui/transcript';

import { isRenderableTranscriptEntry } from '../panes/transcriptEntries';
import { fullTranscriptEntryLayout } from '../panes/transcriptEntryLayout';

interface EntryLinesMemo {
  readonly cols: number;
  readonly lines: readonly string[];
}

// Wrapped-line memo keyed by the immutable entry object. Entries are replaced
// (never mutated in place) when their content changes, so a hit is always
// current, and the WeakMap needs no eviction: a replaced/discarded entry takes
// its slot with it. One slot per entry suffices: the sole caller
// (`TranscriptReader`) lays every entry out at one width per frame, so only
// a resize misses, and then exactly once per entry.
const entryLinesCache = new WeakMap<TranscriptRow, EntryLinesMemo>();

function transcriptEntryLines(
  entry: TranscriptRow,
  cols: number,
): readonly string[] {
  const memo = entryLinesCache.get(entry);
  if (memo && memo.cols === cols) return memo.lines;
  const lines = fullTranscriptEntryLayout(entry, cols).lines;
  entryLinesCache.set(entry, { cols, lines });
  return lines;
}

function isCompactToolEntry(
  entry: TranscriptRow,
  lines: readonly string[],
): boolean {
  return entry.kind === 'tool' && lines.length <= 1;
}

function shouldSeparateEntries({
  previousEntry,
  previousLines,
  nextEntry,
  nextLines,
}: {
  readonly previousEntry: TranscriptRow;
  readonly previousLines: readonly string[];
  readonly nextEntry: TranscriptRow;
  readonly nextLines: readonly string[];
}): boolean {
  // A prompt and the tool rows of its turn read as one block.
  if (previousEntry.kind === 'user' && nextEntry.kind === 'tool') return false;
  return !(
    isCompactToolEntry(previousEntry, previousLines) &&
    isCompactToolEntry(nextEntry, nextLines)
  );
}

/** Render the active slice into a flat line array with blank separators between
 *  substantial entries. Tool run rows stay attached to the prompt or
 *  adjacent compact tools so command-heavy traces do not waste vertical space. */
export function transcriptToLines(
  rows: readonly TranscriptRow[],
  cols: number,
): readonly string[] {
  const out: string[] = [];
  let previousEntry: TranscriptRow | undefined;
  let previousLines: readonly string[] = [];
  for (const entry of rows) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    const lines = transcriptEntryLines(entry, cols);
    if (lines.length === 0) continue;
    if (
      previousEntry !== undefined &&
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
