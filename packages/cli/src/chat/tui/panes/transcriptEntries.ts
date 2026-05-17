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
  readonly live: ConversationEntry | undefined;
} {
  const live = isAppending(status)
    ? findLiveAssistantEntry(entries)
    : undefined;
  const finalized = entries.filter((entry) => entry.finalized);

  return { finalized, live };
}
