import { defaultSession } from '@agent/runtime/SessionHandle';
import { isTerminalOutcomePhase } from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

import {
  activeStreamId,
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

/**
 * Stream phases at which deferred-finalization entries (assistant text and
 * tool rows) are promoted into `<Static>` scrollback. WAITING ends the current
 * turn without ending the run; terminal outcomes end both. In either case the
 * current entries are safe to finalize.
 */
export function isFinalTranscriptStatus(
  status: StreamPhase | undefined,
): boolean {
  return status === STREAM_PHASE.WAITING || isTerminalOutcomePhase(status);
}

let localEntrySeq = 0;

function normalizeTranscriptText(text: string): string {
  return text.trim();
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

  const streamId = explicitStreamId ?? defaultLocalTranscriptStreamId();
  if (!activeStreamId.get()) activeStreamId.set(streamId);
  const syntheticAfterSeq =
    defaultSession().transcripts.get(streamId)?.head ?? 0;

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
    activeStreamId.set(streamId);
  }
  removeStream(CLI_LOCAL_STREAM_ID);
}

export function clearLocalTranscript(): void {
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
