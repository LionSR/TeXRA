/** Attach the shared transcript fold to a live trace and its resident writer. */
// Shared trace and display contracts
import type {
  AgentTrace,
  AgentTraceSubscriber,
  StatusEvent,
} from '@agent/trace';
import { isDebugModeEnabled } from '@logger/logUtils';
import { isTranscriptEvent } from '@shared/schemas';
import { createTranscriptFold } from '@shared/session/traceFold';
import { generateShortId } from '@utils/core';

// Resident transcript writer
import type { TranscriptWriter } from './StreamLogStore';

export interface TranscriptRecorderHandle {
  unsubscribe(): void;
  flushPending(): void;
  handleStatus(event: StatusEvent): void;
}

/** Live and replayed traces use the same entry projection. */
export function attachTranscriptRecorder(
  trace: AgentTrace,
  writer: TranscriptWriter,
): TranscriptRecorderHandle {
  const { streamId } = writer;
  const fold = createTranscriptFold(writer);
  let pendingFailure: unknown;
  const flushPending = (): void => {
    if (pendingFailure !== undefined) throw pendingFailure;
  };
  const subscriber: AgentTraceSubscriber = (event) => {
    flushPending();
    if (!isTranscriptEvent(event)) return;
    try {
      fold.record(
        event.type === 'usage'
          ? {
              type: event.type,
              ...event.payload,
              recordTranscript: event.recordTranscript,
              stageId: event.stageId,
            }
          : event,
        {
          at: Date.now(),
          id: generateShortId(),
          debug: isDebugModeEnabled(),
        },
      );
    } catch (error) {
      pendingFailure = error;
      throw error;
    }
  };
  const unsubscribe = trace.subscribe(subscriber);
  return {
    unsubscribe: () => {
      unsubscribe();
      flushPending();
    },
    flushPending,
    handleStatus: (event) => {
      if (event.streamId !== streamId) return;
      flushPending();
      try {
        fold.status(event.phase);
      } catch (error) {
        pendingFailure = error;
        throw error;
      }
    },
  };
}
