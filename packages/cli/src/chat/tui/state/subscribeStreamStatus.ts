// Mirror the default session's status machine `onDidChange` into the
// per-stream status signal.

import {
  isTerminalOutcomePhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';

import { parentStream } from './childExecutions';
import { activeStreamId } from './cliState';
import { projectStreamTranscriptForStatus } from './transcriptProjection';
import { applyStreamStatusChange, onStreamStatusChange } from './streamStatus';

export function subscribeStreamStatus(): () => void {
  return onStreamStatusChange((change) => {
    // Patch status BEFORE projection so the transcript projector derives
    // `finalizeDeferred` from the current status. A reused stream still
    // carrying `WAITING` from the previous turn would otherwise finalize
    // the next run's first chunks early, shoving partial text into
    // `<Static>` before it finished streaming.
    const recognized = applyStreamStatusChange(change);
    if (recognized) {
      projectStreamTranscriptForStatus(change.streamId, change.status);
    }

    // A lifecycle-owned child completion returns manual focus to that child's
    // immediate owner. WAITING, repair events, unrelated streams, and detached
    // children deliberately leave focus unchanged.
    if (
      change.cause === STREAM_TRANSITION_CAUSE.LIFECYCLE &&
      isTerminalOutcomePhase(change.status) &&
      activeStreamId.get() === change.streamId
    ) {
      const ownerStreamId = parentStream.get().get(change.streamId);
      if (ownerStreamId) activeStreamId.set(ownerStreamId);
    }
  });
}
