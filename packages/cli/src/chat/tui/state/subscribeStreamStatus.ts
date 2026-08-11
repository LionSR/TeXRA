// Mirror canonical session status facts into the per-stream status signal.

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  isTerminalOutcomePhase,
  isTranscriptSettlementPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';

import { parentStream } from './childExecutions';
import {
  activeStreamId,
  focusStream,
  setStreamStatusInCliState,
} from './cliState';
import { projectStreamTranscript } from './transcriptProjection';

export function subscribeStreamStatus(): () => void {
  return defaultSession().events.subscribeStatus((change) => {
    // Patch status BEFORE projection so the transcript projector derives
    // `finalizeDeferred` from the current status. A reused stream still
    // carrying `WAITING` from the previous turn would otherwise finalize
    // the next run's first chunks early, shoving partial text into
    // `<Static>` before it finished streaming.
    const recognized = setStreamStatusInCliState({
      streamId: change.streamId,
      status: change.phase,
      substate: change.substate,
    });
    if (recognized) {
      projectStreamTranscript(change.streamId, {
        finalize: isTranscriptSettlementPhase(change.phase),
      });
    }

    // A completed or user-stopped child returns manual focus to that child's
    // immediate owner. WAITING, repair events, unrelated streams, and detached
    // children deliberately leave focus unchanged.
    if (
      (change.cause === STREAM_TRANSITION_CAUSE.LIFECYCLE ||
        change.cause === STREAM_TRANSITION_CAUSE.USER_STOP) &&
      isTerminalOutcomePhase(change.phase) &&
      activeStreamId.get() === change.streamId
    ) {
      const ownerStreamId = parentStream.get().get(change.streamId);
      if (ownerStreamId) focusStream(ownerStreamId);
    }
  });
}
