// Flatten a stream's conversation entries into full-fidelity plain-text lines
// for the ctrl+t transcript viewer. Unlike the finalized scrollback and the
// live region — which slice tool output to a head+tail preview — this renders
// every line so the viewer is the place to read the complete output.

import { isRenderableTranscriptEntry } from '../panes/transcriptEntries';
import { transcriptEntryLayout } from '../panes/transcriptEntryLayout';
import type { ConversationEntry, StreamSlice } from './cliState';

// Wrapped-line cache keyed by the immutable entry object. Entries are
// replaced (never mutated in place) when their content changes, so hits are
// always current. Each entry can be rendered at several widths in the same
// frame (terminal transcript, static row budget, task-detail panel), so keep
// the width dimension inside the entry cache instead of letting callers thrash
// a single slot.
const entryLinesCache = new WeakMap<
  ConversationEntry,
  Map<number, readonly string[]>
>();

export function transcriptEntryLines(
  entry: ConversationEntry,
  cols: number,
): readonly string[] {
  const cachedByCols = entryLinesCache.get(entry);
  const cached = cachedByCols?.get(cols);
  if (cached) return cached;
  const lines = computeTranscriptEntryLines(entry, cols);
  if (cachedByCols) {
    cachedByCols.set(cols, lines);
  } else {
    entryLinesCache.set(entry, new Map([[cols, lines]]));
  }
  return lines;
}

function computeTranscriptEntryLines(
  entry: ConversationEntry,
  cols: number,
): readonly string[] {
  return transcriptEntryLayout(entry, {
    mode: 'viewer',
    width: cols,
  }).lines;
}

function isCompactToolEntry(
  entry: ConversationEntry,
  lines: readonly string[],
): boolean {
  return entry.role === 'tool' && lines.length <= 1;
}

function isPromptToToolTurn(
  previousEntry: ConversationEntry,
  nextEntry: ConversationEntry,
): boolean {
  return previousEntry.role === 'user' && nextEntry.role === 'tool';
}

function shouldSeparateEntries({
  previousEntry,
  previousLines,
  nextEntry,
  nextLines,
}: {
  readonly previousEntry: ConversationEntry | undefined;
  readonly previousLines: readonly string[];
  readonly nextEntry: ConversationEntry;
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
): readonly string[] {
  if (!slice) return [];
  const out: string[] = [];
  let previousEntry: ConversationEntry | undefined;
  let previousLines: readonly string[] = [];
  for (const entry of slice.entries) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    const lines = transcriptEntryLines(entry, cols);
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
