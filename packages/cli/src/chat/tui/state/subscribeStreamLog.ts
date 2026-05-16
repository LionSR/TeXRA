// Mirror StreamLogStore user/model entries into `cliState.streams[].entries`.
// Tool/approval entries land in side panels and modals.

import { AgentLogger } from '@logger/AgentLogger';
import {
  MESSAGE_TYPES,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';

import { cliState, patchStream, type ConversationEntry } from './cliState';

const TRANSCRIPT_MESSAGE_TYPES = new Set<string>([
  MESSAGE_TYPES.MODEL_RESPONSE,
  MESSAGE_TYPES.USER_MESSAGE,
]);

const STREAM_SYNC_THROTTLE_MS = 200;

export function subscribeStreamLog(): () => void {
  const store = AgentLogger.getStreamLogStore();
  const pendingTimers = new Map<StreamTabId, ReturnType<typeof setTimeout>>();

  const dispose = store.onChange((streamId) => {
    if (pendingTimers.has(streamId)) return;
    const timer = setTimeout(() => {
      pendingTimers.delete(streamId);
      syncStreamLog(streamId);
    }, STREAM_SYNC_THROTTLE_MS);
    pendingTimers.set(streamId, timer);
  });

  return () => {
    dispose();
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
  };
}

export function syncStreamLog(streamId: StreamTabId): void {
  const store = AgentLogger.getStreamLogStore();
  const log = store.get(streamId);
  if (!log) return;

  const responses = log
    .getRange(0)
    .filter((entry: StreamLogEntry) =>
      TRANSCRIPT_MESSAGE_TYPES.has(entry.messageType ?? ''),
    );

  patchStream(streamId, (slice) => {
    const existing = new Map(slice.entries.map((e) => [e.id, e]));
    let changed = slice.entries.length !== responses.length;
    const next = responses.map((entry: StreamLogEntry) => {
      const text = entry.text ?? '';
      const role: ConversationEntry['role'] =
        entry.messageType === MESSAGE_TYPES.USER_MESSAGE ? 'user' : 'assistant';
      const prev = existing.get(entry.id);
      if (prev && prev.text === text && prev.role === role) return prev;
      changed = true;
      return { id: entry.id, role, text, finalized: role === 'user' };
    });
    if (!changed) return slice;
    return { ...slice, entries: next };
  });

  // Surface stream as active if we don't already have one — handles bare
  // `texra chat` where setActiveStream is the first signal the runtime emits.
  if (!cliState.activeStreamId.get()) {
    cliState.activeStreamId.set(streamId);
  }
}
