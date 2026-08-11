import { defaultSession } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import {
  activeStreamId,
  focusStream,
  rootStreamId,
  registerCliStateResetHook,
  removeStream,
  patchStream,
  streams,
  type ConversationEntry,
} from './cliState';
import { parentStream } from './childExecutions';
import { activeStreamParentOrSelfId } from './streamViews';

export const CLI_LOCAL_STREAM_ID = 'cli-local' as StreamTabId;

let localEntrySeq = 0;

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
  const normalized = text.trim();
  if (!normalized) return;

  const streamId = explicitStreamId ?? defaultLocalTranscriptStreamId();
  focusStream(streamId, { onlyIfUnset: true });
  const log = defaultSession().transcripts.get(streamId);
  const syntheticAfterSeq = log?.head ?? 0;
  const syntheticAfterSettlementSeqNo = log?.settlementHead ?? 0;

  patchStream(streamId, (slice) => {
    const entry: ConversationEntry = {
      id: `local:${localEntrySeq++}:${streamId}:${slice.entries.length}`,
      role,
      text: normalized,
      finalized: true,
      synthetic: true,
      syntheticKind: 'local',
      syntheticAfterSeq,
      syntheticAfterSettlementSeqNo,
    };
    return { ...slice, entries: [...slice.entries, entry] };
  });
}

/**
 * Local UI notices are root-owned unless a caller explicitly targets a child.
 * A focused child should not receive session-level slash/status/error rows.
 */
export function resolveLocalTranscriptStreamId({
  activeStreamId,
  fallbackStreamId,
  parentStream,
  rootStreamId,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly fallbackStreamId: StreamTabId;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly rootStreamId: StreamTabId | undefined;
}): StreamTabId {
  if (rootStreamId) return rootStreamId;
  return (
    activeStreamParentOrSelfId({ activeStreamId, parentStream }) ??
    fallbackStreamId
  );
}

function defaultLocalTranscriptStreamId(): StreamTabId {
  return resolveLocalTranscriptStreamId({
    activeStreamId: activeStreamId.get(),
    fallbackStreamId: CLI_LOCAL_STREAM_ID,
    parentStream: parentStream.get(),
    rootStreamId: rootStreamId.get(),
  });
}

export function moveLocalTranscriptToStream(streamId: StreamTabId): void {
  if (streamId === CLI_LOCAL_STREAM_ID) return;

  const localSlice = streams.get().get(CLI_LOCAL_STREAM_ID);
  if (!localSlice?.entries.length) return;

  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [...localSlice.entries, ...slice.entries],
  }));
  if (activeStreamId.get() === CLI_LOCAL_STREAM_ID) {
    focusStream(streamId);
  }
  removeStream(CLI_LOCAL_STREAM_ID);
}

export function clearLocalTranscript(): void {
  removeStream(CLI_LOCAL_STREAM_ID);
}

function resetTranscriptState(): void {
  localEntrySeq = 0;
}

registerCliStateResetHook(resetTranscriptState);
