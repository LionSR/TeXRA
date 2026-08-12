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
import {
  releaseInactiveStreamTranscript,
  syncStreamLog,
} from './subscribeStreamLog';

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
      syncStreamLog(
        change.streamId,
        isTranscriptSettlementPhase(change.phase) ? { forceFinal: true } : {},
      );
      // Lifecycle owns transcript residency: a stream that just left its
      // active phase releases here, after the sync above folded its final
      // rows — not from the render path, which may never run for it again.
      releaseInactiveStreamTranscript(change.streamId);
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
