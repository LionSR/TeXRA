import { defaultSession } from '@agent/runtime';
import type { StreamTabId } from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@shared/transcript';
import {
  activeStreamId,
  focusStream,
  rootStreamId,
  registerCliStateResetHook,
  removeStream,
  patchStream,
  streams,
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

/**
 * A CLI notice as an ordinary transcript row. `origin: 'local'` is the whole
 * difference from a projected row: it says there is no `StreamLogEntry` behind
 * this one, which is what makes it immutable from birth and what places it
 * after an equal-keyed source row. Its position comes from the two log cursors
 * captured at append time, carried in the row's own ordering fields.
 */
function localTranscriptRow(
  kind: 'assistant' | 'error' | 'user',
  id: string,
  text: string,
  seqNo: number,
  settlementSeqNo: number,
): TranscriptRow {
  const base = {
    id,
    origin: 'local',
    seqNo,
    settlementSeqNo,
    timestamp: Date.now(),
  } as const;
  const body = transcriptText(text);
  if (kind === 'error') {
    return {
      ...base,
      level: 'error',
      kind: 'error',
      summary: body,
      details: [],
      detailText: transcriptText(''),
    };
  }
  if (kind === 'user') {
    return { ...base, level: 'info', kind: 'user', text: body, summary: body };
  }
  return {
    ...base,
    level: 'info',
    kind: 'assistant',
    text: body,
    streaming: false,
  };
}

function appendLocalTranscriptEntry(
  kind: 'assistant' | 'error' | 'user',
  text: string,
  explicitStreamId?: StreamTabId,
): void {
  const normalized = text.trim();
  if (!normalized) return;

  const streamId = explicitStreamId ?? defaultLocalTranscriptStreamId();
  focusStream(streamId, { onlyIfUnset: true });
  const log = defaultSession().transcripts.get(streamId);
  const seqNo = log?.head ?? 0;
  const settlementSeqNo = log?.settlementHead ?? 0;

  patchStream(streamId, (slice) => ({
    ...slice,
    entries: [
      ...slice.entries,
      localTranscriptRow(
        kind,
        `local:${localEntrySeq++}:${streamId}:${slice.entries.length}`,
        normalized,
        seqNo,
        settlementSeqNo,
      ),
    ],
  }));
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
    // The re-homed rows are printable on arrival and land ahead of everything
    // already promoted, so the promotion cursor shifts with them.
    finalizedFrontier: slice.finalizedFrontier + localSlice.entries.length,
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
