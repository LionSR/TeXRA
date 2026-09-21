import { Effect } from 'effect';
import { describeFollowUpFailure } from '@agent/runtime';
import {
  resumeClaimedRun,
  type ResumeRunOptions,
} from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpFailureReason } from '@agent/followUp/ToolUseFollowUp';
import type { RunId } from '@shared/schemas';

/**
 * The per-attempt monotone cancellation latch every resuming host holds:
 * once this attempt has observed the run gone from the session's view,
 * re-creating the same run id cannot make the attempt admissible again — the
 * resumed state is not the state the attempt was admitted against.
 *
 * `alsoCancelled` carries a host's own reasons to abandon the attempt (a
 * desktop shutting down, a paper the registry has dropped). They are asked
 * each time rather than latched: they are facts about the host, not about
 * this attempt's run.
 */
export function resumeCancellationLatch(
  session: SessionHandle,
  runId: RunId,
  alsoCancelled?: () => boolean,
): () => boolean {
  let runMissing = false;
  return () => {
    if (!runMissing && session.runView(runId) === undefined) {
      runMissing = true;
    }
    return runMissing || alsoCancelled?.() === true;
  };
}

/** Resume a host-owned stream and present an ordinary refusal consistently. */
export const resumeRunWithRefusalNotice = Effect.fn(
  'resumeRunWithRefusalNotice',
)(function* (
  runId: RunId,
  options: ResumeRunOptions & { readonly session: SessionHandle },
  onRefused?: (failure: FollowUpFailureReason) => void,
) {
  const result = yield* resumeClaimedRun(runId, options);
  if ('started' in result) return result.delivered;
  if (options.isCancellationRequested?.() === true) return false;

  onRefused?.(result.failed);
  const { session } = options;
  yield* session.interactions.emit(
    'requestShowInstruction',
    {
      key: 'resumeRefused',
      message: describeFollowUpFailure(result.failed),
      showSuppress: false,
    },
    { replayWhenAttached: true },
  );
  return false;
});
