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
  /** Tool calls still running. Re-rendered on every store sync so the
   *  status dot transitions in place; promoted to `finalized` once the
   *  underlying entry flips `finalized: true`. */
  readonly pendingTools: ConversationEntry[];
  readonly live: ConversationEntry | undefined;
} {
  const live = isAppending(status)
    ? findLiveAssistantEntry(entries)
    : undefined;
  const finalized: ConversationEntry[] = [];
  const pendingTools: ConversationEntry[] = [];
  for (const entry of entries) {
    if (entry.finalized) {
      finalized.push(entry);
      continue;
    }
    if (entry.role === 'tool') pendingTools.push(entry);
  }
  return { finalized, pendingTools, live };
}
