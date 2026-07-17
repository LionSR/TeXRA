// Mirror the default session's status machine `onDidChange` into the
// per-stream status signal.

import { activeStreamId, rootStreamId, streams } from './cliState';
import { parentStream } from './childExecutions';
import { autoReturnFocusTarget } from './autoReturnFocus';
import { projectStreamTranscriptForStatus } from './transcriptProjection';
import { applyStreamStatusChange, onStreamStatusChange } from './streamStatus';

export function subscribeStreamStatus(): () => void {
  return onStreamStatusChange((change) => {
    // The pre-apply slice still holds the previous status — exactly the
    // edge information the auto-return decision needs, with no extra
    // bookkeeping.
    const previousStatus = streams.get().get(change.streamId)?.status;
    // Patch status BEFORE projection so the transcript projector derives
    // `finalizeDeferred` from the current status. A reused stream still
    // carrying `WAITING` from the previous turn would otherwise finalize
    // the next run's first chunks early, shoving partial text into
    // `<Static>` before it finished streaming.
    applyStreamStatusChange(change);
    projectStreamTranscriptForStatus(change.streamId, change.status);
    // A focused child that just finished hands the viewport back to root —
    // that is where its report streams next.
    const returnTarget = autoReturnFocusTarget({
      activeStreamId: activeStreamId.get(),
      parentStream: parentStream.get(),
      previousStatus,
      rootStreamId: rootStreamId.get(),
      status: change.status,
      streamId: change.streamId,
    });
    if (returnTarget !== undefined) activeStreamId.set(returnTarget);
  });
}
