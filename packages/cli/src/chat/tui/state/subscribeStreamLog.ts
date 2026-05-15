// Mirror StreamLogStore `MODEL_RESPONSE` deltas into `cliState.streams[].entries`.
// Phase 1 only renders model responses; tool/approval entries land later.

import { AgentLogger } from '@logger/AgentLogger';
import {
  MESSAGE_TYPES,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';

import { cliState, patchStream } from './cliState';

export function subscribeStreamLog(): () => void {
  const store = AgentLogger.getStreamLogStore();
  return store.onChange((streamId) => syncStream(streamId));
}

function syncStream(streamId: StreamTabId): void {
  const store = AgentLogger.getStreamLogStore();
  const log = store.get(streamId);
  if (!log) return;

  const responses = log
    .getRange(0)
    .filter(
      (entry: StreamLogEntry) =>
        entry.messageType === MESSAGE_TYPES.MODEL_RESPONSE,
    );

  patchStream(streamId, (slice) => {
    const existing = new Map(slice.entries.map((e) => [e.id, e]));
    let changed = slice.entries.length !== responses.length;
    const next = responses.map((entry: StreamLogEntry) => {
      const text = entry.text ?? '';
      const prev = existing.get(entry.id);
      if (prev && prev.text === text) return prev;
      changed = true;
      return { id: entry.id, text, finalized: false };
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
