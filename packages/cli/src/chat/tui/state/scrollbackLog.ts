// Append-only scrollback log for the Ink `<Static>` history region.
//
// Ink 7's `<Static>` only ever renders items appended to the end of its
// `items` array (`items.slice(index)` with a monotonically climbing
// `index`). Swapping in a different array — e.g. when Tab switches the
// active stream — prints nothing new and strands the previous lines in
// scrollback. So the transcript that backs `<Static>` must be ONE
// append-only list merged across every stream; per-stream switching only
// drives the live (dynamic) region, never the committed history.
//
// Finalized entries are immutable (assistant text is frozen by
// `finalizeAssistantTranscriptEntries`, tool rows finalize with their final
// state at end-of-stream), so committing them once is safe.

import { signal, Signal } from '@lit-labs/signals';

import type { StreamTabId } from '@shared/schemas';

import {
  cliState,
  registerCliStateResetHook,
  type ConversationEntry,
} from './cliState';

export interface ScrollbackItem {
  /** Stable React key — the entry id, which is unique across streams. */
  readonly key: string;
  /** Stream the entry belongs to (used to label sub-agent history). */
  readonly streamId: StreamTabId;
  readonly entry: ConversationEntry;
}

// Typed as a mutable array (not `readonly`) to satisfy Ink's `<Static>`
// `items: T[]` prop without copying the whole history every render. The
// array is only ever *replaced* (never mutated in place), so the
// append-only invariant still holds.
const SCROLLBACK = signal<ScrollbackItem[]>([]);

/** The committed, append-only finalized transcript across all streams. */
export const scrollbackLog = SCROLLBACK as Signal.State<ScrollbackItem[]>;

// Entry ids already committed. Keyed by `entry.id` alone (not
// `streamId:id`) so re-parenting a local entry into its real stream via
// `moveLocalTranscriptToStream` — which keeps the id but changes the stream —
// does not commit it twice.
const committedIds = new Set<string>();

/** Commit any newly-finalized entries to the append-only log, preserving
 *  insertion order. Cheap and idempotent: each entry is appended at most
 *  once. Iterates streams in Map order, then entries in stream order, which
 *  matches arrival order in the common single-stream case. */
export function syncScrollbackFromStreams(): void {
  const streams = cliState.streams.get();
  let next: ScrollbackItem[] | undefined;
  for (const [streamId, slice] of streams) {
    for (const entry of slice.entries) {
      if (!entry.finalized) continue;
      if (committedIds.has(entry.id)) continue;
      committedIds.add(entry.id);
      (next ??= [...SCROLLBACK.get()]).push({
        key: entry.id,
        streamId,
        entry,
      });
    }
  }
  if (next) SCROLLBACK.set(next);
}

/** Begin committing finalized entries to the scrollback log as streams
 *  change. Returns a disposer. Mirrors the `Signal.subtle.Watcher`
 *  re-arm pattern in `useSignal`. */
export function startScrollbackSync(): () => void {
  syncScrollbackFromStreams();
  const watcher = new Signal.subtle.Watcher(() => {
    syncScrollbackFromStreams();
    watcher.watch();
  });
  watcher.watch(cliState.streams);
  return () => watcher.unwatch(cliState.streams);
}

registerCliStateResetHook(() => {
  committedIds.clear();
  SCROLLBACK.set([]);
});
