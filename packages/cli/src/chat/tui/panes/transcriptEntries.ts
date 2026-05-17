import { STREAM_STATUS, type StreamStatus } from '@shared/schemas';

import type { ConversationEntry } from '../state/cliState';

function isAppending(status: StreamStatus | undefined): boolean {
  return (
    status === STREAM_STATUS.INITIALIZING ||
    status === STREAM_STATUS.RUNNING ||
    status === STREAM_STATUS.RESUMING
  );
}

function findLiveAssistantEntry(
  entries: readonly ConversationEntry[],
): ConversationEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant' || entry.finalized) continue;
    return entry;
  }
  return undefined;
}

export function splitTranscriptEntries(
  entries: readonly ConversationEntry[],
  status: StreamStatus | undefined,
): {
  readonly finalized: ConversationEntry[];
  /** Non-finalized entries in original stream order. The renderer must
   *  walk this list (rather than rendering tool rows and the live
   *  assistant as separate buckets) so that text emitted before a tool
   *  call appears above the tool row instead of below it. Tool entries
   *  defer finalization until the stream itself finalizes — promoting
   *  them earlier would let a fast tool jump ahead of still-streaming
   *  assistant text in `<Static>` scrollback, where insertion order is
   *  fixed. */
  readonly pending: ConversationEntry[];
  /** Kept for callers (and tests) that only care about the streaming
   *  assistant entry. Derived from `entries`. */
  readonly live: ConversationEntry | undefined;
} {
  const showLiveAssistant = isAppending(status);
  const finalized: ConversationEntry[] = [];
  const pending: ConversationEntry[] = [];
  for (const entry of entries) {
    if (entry.finalized) {
      finalized.push(entry);
      continue;
    }
    if (entry.role === 'tool') {
      pending.push(entry);
      continue;
    }
    if (entry.role === 'assistant' && showLiveAssistant) {
      pending.push(entry);
    }
  }
  const live = showLiveAssistant ? findLiveAssistantEntry(entries) : undefined;
  return { finalized, pending, live };
}
