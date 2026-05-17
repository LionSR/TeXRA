import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId } from '@shared/schemas';

import {
  cliState,
  patchStream,
  removeStream,
  registerCliStateResetHook,
  type ConversationEntry,
} from './cliState';

export const CLI_LOCAL_STREAM_ID = 'cli-local' as StreamTabId;

let localEntrySeq = 0;
const clearedHeadByStream = new Map<StreamTabId, number>();

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
  const syntheticAfterSeq =
    AgentLogger.getStreamLogStore().get(streamId)?.head ?? 0;

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

export function appendLocalAssistantTranscript(text: string): void {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) return;

  const streamId = cliState.activeStreamId.get() ?? CLI_LOCAL_STREAM_ID;
  if (!cliState.activeStreamId.get()) cliState.activeStreamId.set(streamId);
  const syntheticAfterSeq =
    AgentLogger.getStreamLogStore().get(streamId)?.head ?? 0;

  patchStream(streamId, (slice) => {
    const entry: ConversationEntry = {
      id: `local:${localEntrySeq++}:${streamId}:${slice.entries.length}`,
      role: 'assistant',
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

export function finalizeAssistantTranscriptEntries(
  streamId: StreamTabId,
): void {
  patchStream(streamId, (slice) => {
    let changed = false;
    const entries = slice.entries.map((entry) => {
      if (entry.role !== 'assistant' || entry.finalized) return entry;
      changed = true;
      return { ...entry, finalized: true };
    });
    return changed ? { ...slice, entries } : slice;
  });
}

export function clearActiveTranscript(): void {
  const activeStreamId = cliState.activeStreamId.get();
  if (!activeStreamId) {
    cliState.streams.set(new Map());
    return;
  }

  const head = AgentLogger.getStreamLogStore().get(activeStreamId)?.head ?? 0;
  clearedHeadByStream.set(activeStreamId, head);
  patchStream(activeStreamId, (slice) => ({ ...slice, entries: [] }));
}

export function getTranscriptStartSeq(streamId: StreamTabId): number {
  return clearedHeadByStream.get(streamId) ?? 0;
}

function resetTranscriptState(): void {
  localEntrySeq = 0;
  clearedHeadByStream.clear();
}

registerCliStateResetHook(resetTranscriptState);
