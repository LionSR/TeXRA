// Flatten a stream's conversation entries into full-fidelity plain-text
// display lines. Unlike the finalized scrollback and the live region, this
// renders every tool-output line.

import { LRUCache } from 'lru-cache';

import type { TranscriptRow } from '@shared/transcript';

import { isRenderableTranscriptEntry } from '../panes/transcriptEntries';
import { fullTranscriptEntryLayout } from '../panes/transcriptEntryLayout';
import type { StreamSlice } from './cliState';

// Wrapped-line cache keyed by the immutable entry object. Entries are
// replaced (never mutated in place) when their content changes, so hits are
// always current, and the outer WeakMap needs no manual eviction: once an
// entry is replaced/discarded, its cache slot (and everything nested under
// it) becomes unreachable and is reclaimed with it. Each entry can be
// rendered at several widths in the same frame (terminal transcript, static
// row budget, task-detail panel), so the width axis is folded into the key
// inside a flat `Map` nested one level under the entry — GC-tied on the
// primary (entry) axis without an extra WeakMap level for the width.
//
// The executions header label is *not* an axis of this key: it is frozen into
// the row at projection time (the fold samples the live labels, the shared
// model folds them into `headerPreview`), so a change to the live label
// roster can never make a cached line for an unchanged entry go stale.

// Cap each entry's composite-key slots so a long session with many terminal
// resizes can't grow an entry's inner cache forever — only the outer
// WeakMap's entry-level eviction is free (GC-tied); the width keys inside it
// are strong references the entry itself won't drop on its own. In practice
// only the current width is re-rendered at once, so a small cap costs no
// realistic hit rate. Genuine LRU (not insertion-order) eviction costs nothing
// extra here and avoids evicting a slot that was just re-hit.
const MAX_LINES_PER_ENTRY = 4;

const entryLinesCache = new WeakMap<
  TranscriptRow,
  LRUCache<string, readonly string[]>
>();

function transcriptEntryLines(
  entry: TranscriptRow,
  cols: number,
): readonly string[] {
  const key = String(cols);
  const cachedByEntry = entryLinesCache.get(entry);
  const cached = cachedByEntry?.get(key);
  if (cached) return cached;
  const lines = fullTranscriptEntryLayout(entry, cols).lines;
  if (cachedByEntry) {
    cachedByEntry.set(key, lines);
  } else {
    const cache = new LRUCache<string, readonly string[]>({
      max: MAX_LINES_PER_ENTRY,
    });
    cache.set(key, lines);
    entryLinesCache.set(entry, cache);
  }
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
): readonly string[] {
  if (!slice) return [];
  const out: string[] = [];
  let previousEntry: TranscriptRow | undefined;
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
