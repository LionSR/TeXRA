import { getDefaultStreamLogStore } from '@transcript';
import {
  STREAM_STATUS,
  type StreamStatus,
  type StreamTabId,
} from '@shared/schemas';

import {
  cliState,
  patchStream,
  removeStream,
  registerCliStateResetHook,
  type ConversationEntry,
} from './cliState';

export const CLI_LOCAL_STREAM_ID = 'cli-local' as StreamTabId;

/** Stream statuses at which deferred-finalization entries (assistant text
 *  and tool rows) are promoted into `<Static>` scrollback. */
const FINAL_TRANSCRIPT_STATUSES: ReadonlySet<StreamStatus> = new Set([
  STREAM_STATUS.ERROR,
  STREAM_STATUS.READY,
  STREAM_STATUS.STOPPED,
  STREAM_STATUS.WAITING,
]);

export function isFinalTranscriptStatus(
  status: StreamStatus | undefined,
): boolean {
  return status !== undefined && FINAL_TRANSCRIPT_STATUSES.has(status);
}

let localEntrySeq = 0;

function normalizeTranscriptText(text: string): string {
  return text.trim();
}

export function appendAssistantTranscriptIfMissing(
  streamId: StreamTabId,
  text: string | undefined,
  idPrefix = 'assistant',
): void {
  const normalized = normalizeTranscriptText(text ?? '');
  if (!normalized) return;
  const syntheticAfterSeq = getDefaultStreamLogStore().get(streamId)?.head ?? 0;

  patchStream(streamId, (slice) => {
    const entryId = `${idPrefix}:${streamId}`;
    const alreadyRendered = slice.entries.some(
      (entry) =>
        entry.id === entryId ||
        (!entry.synthetic &&
          entry.role === 'assistant' &&
          normalizeTranscriptText(entry.text) === normalized),
    );
    if (alreadyRendered) return slice;

    const entry: ConversationEntry = {
      id: entryId,
      role: 'assistant',
      text: normalized,
      finalized: true,
      synthetic: true,
      syntheticKind: 'final',
      syntheticAfterSeq,
    };
    return { ...slice, entries: [...slice.entries, entry] };
  });
}

export function appendLocalAssistantTranscript(
  text: string,
  streamId?: StreamTabId,
): void {
  appendLocalTranscriptEntry('assistant', text, streamId);
}

export function appendLocalErrorTranscript(text: string): void {
  appendLocalTranscriptEntry('error', text);
}

export function appendLocalUserTranscript(text: string): void {
  appendLocalTranscriptEntry('user', text);
}

function appendLocalTranscriptEntry(
  role: 'assistant' | 'error' | 'user',
  text: string,
  explicitStreamId?: StreamTabId,
): void {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return;

  const streamId =
    explicitStreamId ?? cliState.activeStreamId.get() ?? CLI_LOCAL_STREAM_ID;
  if (!cliState.activeStreamId.get()) cliState.activeStreamId.set(streamId);
  const syntheticAfterSeq = getDefaultStreamLogStore().get(streamId)?.head ?? 0;

  patchStream(streamId, (slice) => {
    const entry: ConversationEntry = {
      id: `local:${localEntrySeq++}:${streamId}:${slice.entries.length}`,
      role,
      text: normalized,
      finalized: true,
      synthetic: true,
      syntheticKind: 'local',
      syntheticAfterSeq,
    };
    return { ...slice, entries: [...slice.entries, entry] };
  });
}

export function moveLocalTranscriptToStream(streamId: StreamTabId): void {
  if (streamId === CLI_LOCAL_STREAM_ID) return;

  const localSlice = cliState.streams.get().get(CLI_LOCAL_STREAM_ID);
  if (!localSlice?.entries.length) return;

  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [...localSlice.entries, ...slice.entries],
  }));
  if (cliState.activeStreamId.get() === CLI_LOCAL_STREAM_ID) {
    cliState.activeStreamId.set(streamId);
  }
  removeStream(CLI_LOCAL_STREAM_ID);
}

/** Finalizes any entries that defer finalization to end-of-stream
 *  (assistant text and tool rows). Tool rows are included so that a
 *  fast-completing tool doesn't jump ahead of still-streaming assistant
 *  text in `<Static>` scrollback — see the deferral comment in
 *  `subscribeStreamLog.renderLogEntry`. */
export function finalizeAssistantTranscriptEntries(
  streamId: StreamTabId,
): void {
  patchStream(streamId, (slice) => {
    let changed = false;
    const entries = slice.entries.map((entry) => {
      if (entry.finalized) return entry;
      if (entry.role !== 'assistant' && entry.role !== 'tool') return entry;
      changed = true;
      return { ...entry, finalized: true };
    });
    return changed ? { ...slice, entries } : slice;
  });
}

function resetTranscriptState(): void {
  localEntrySeq = 0;
}

registerCliStateResetHook(resetTranscriptState);
