import {
  LIVE_ELAPSED_STREAM_STATUSES,
  type StreamStatus,
} from '@shared/schemas';
import { stripAnsiSequences } from '@cli/runtime/ansiEscapes';

import type { ConversationEntry } from '../state/cliState';

export function isRenderableTranscriptEntry(entry: ConversationEntry): boolean {
  switch (entry.role) {
    case 'assistant':
    case 'error':
    case 'user':
      return stripAnsiSequences(entry.text).trim().length > 0;
    case 'process':
      return entry.process !== undefined;
    case 'tool':
      return entry.toolUse !== undefined;
  }
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
} {
  const showLiveAssistant =
    status !== undefined && LIVE_ELAPSED_STREAM_STATUSES.has(status);
  const finalized: ConversationEntry[] = [];
  const pending: ConversationEntry[] = [];
  for (const entry of entries) {
    if (!isRenderableTranscriptEntry(entry)) continue;
    if (entry.finalized) {
      finalized.push(entry);
      continue;
    }
    if (entry.role === 'tool') {
      pending.push(entry);
      continue;
    }
    if (entry.role === 'process') {
      finalized.push(entry);
      continue;
    }
    if (entry.role === 'assistant' && showLiveAssistant) {
      pending.push(entry);
    }
  }
  return { finalized, pending };
}
