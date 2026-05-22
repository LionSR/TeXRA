import { afterEach, describe, expect, it } from 'vitest';

import type { StreamTabId } from '@shared/schemas';

import {
  cliState,
  patchStream,
  resetCliState,
  type ConversationEntry,
} from '../../../packages/cli/src/chat/tui/state/cliState';
import {
  scrollbackLog,
  syncScrollbackFromStreams,
} from '../../../packages/cli/src/chat/tui/state/scrollbackLog';

const ROOT = 'root-stream' as StreamTabId;
const CHILD = 'child-stream' as StreamTabId;

function entry(
  id: string,
  text: string,
  finalized: boolean,
): ConversationEntry {
  return { id, role: 'assistant', text, finalized };
}

function append(streamId: StreamTabId, ...entries: ConversationEntry[]): void {
  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [...slice.entries, ...entries],
  }));
}

function logTexts(): string[] {
  return scrollbackLog.get().map((item) => item.entry.text);
}

describe('CLI scrollback log (Static history backing store)', () => {
  afterEach(() => {
    resetCliState();
    syncScrollbackFromStreams();
  });

  it('commits only finalized entries, in stream order', () => {
    append(ROOT, entry('a', 'first', true), entry('b', 'in-flight', false));
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual(['first']);
  });

  it('is append-only: committed entries are never dropped or reordered as new ones finalize', () => {
    append(ROOT, entry('a', 'first', true));
    syncScrollbackFromStreams();
    const firstRef = scrollbackLog.get();

    append(ROOT, entry('b', 'second', true));
    syncScrollbackFromStreams();

    expect(logTexts()).toEqual(['first', 'second']);
    // New array reference (so `<Static>` sees a change) but the existing
    // item objects are reused, preserving identity for already-printed rows.
    expect(scrollbackLog.get()).not.toBe(firstRef);
    expect(scrollbackLog.get()[0]).toBe(firstRef[0]);
  });

  it('commits each entry exactly once even when re-synced repeatedly', () => {
    append(ROOT, entry('a', 'first', true));
    syncScrollbackFromStreams();
    syncScrollbackFromStreams();
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual(['first']);
  });

  it('does not double-commit when an entry is re-parented to another stream (same id)', () => {
    // Mirrors moveLocalTranscriptToStream: the entry keeps its id but moves
    // streams. Dedup is keyed by entry.id, so it must not appear twice.
    append(ROOT, entry('shared-id', 'hello', true));
    syncScrollbackFromStreams();

    // Re-parent: same id now lives under CHILD too.
    append(CHILD, entry('shared-id', 'hello', true));
    syncScrollbackFromStreams();

    expect(logTexts()).toEqual(['hello']);
  });

  it('merges finalized entries across streams into one linear log', () => {
    append(ROOT, entry('r1', 'root-1', true));
    append(CHILD, entry('c1', 'child-1', true));
    syncScrollbackFromStreams();
    // Both present; root stream (inserted first) precedes the child.
    expect(logTexts()).toEqual(['root-1', 'child-1']);
  });

  it('promotes an entry once it transitions to finalized', () => {
    append(ROOT, entry('a', 'streaming…', false));
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual([]);

    // Finalize in place (new object, same id) as finalizeAssistantTranscriptEntries does.
    patchStream(ROOT, (slice) => ({
      ...slice,
      entries: slice.entries.map((e) =>
        e.id === 'a' ? { ...e, finalized: true } : e,
      ),
    }));
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual(['streaming…']);
  });

  it('clears on session reset', () => {
    append(ROOT, entry('a', 'first', true));
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual(['first']);

    resetCliState();
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual([]);
    // A fresh entry with a previously-seen id still commits after reset.
    cliState.activeStreamId.set(ROOT);
    append(ROOT, entry('a', 'reborn', true));
    syncScrollbackFromStreams();
    expect(logTexts()).toEqual(['reborn']);
  });
});
