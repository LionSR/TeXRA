import { Effect } from 'effect';
import { describeFollowUpFailure } from '@agent/runtime';
import {
  resumeClaimedRun,
  type ResumeRunOptions,
} from '@agent/runtime/resumeRun';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpFailureReason } from '@agent/followUp/ToolUseFollowUp';
import type { RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

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
  yield* Effect.tryPromise({
    try: async () =>
      session.interactions.emit(
        'requestShowInstruction',
        {
          key: 'resumeRefused',
          message: describeFollowUpFailure(result.failed),
          showSuppress: false,
        },
        { replayWhenAttached: true },
      ),
    catch: ensureError,
  });
  return false;
});
