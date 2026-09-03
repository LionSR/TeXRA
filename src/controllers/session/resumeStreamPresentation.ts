import { describeFollowUpFailure, defaultSession } from '@agent/runtime';
import { resumeStream, type ResumeRunOptions } from '@agent/runtime/resumeRun';
import type { FollowUpFailureReason } from '@agent/followUp/ToolUseFollowUp';
import type { StreamTabId } from '@shared/schemas';

/** Resume a host-owned stream and present an ordinary refusal consistently. */
export async function resumeStreamWithRefusalNotice(
  streamId: StreamTabId,
  options: ResumeRunOptions,
  onRefused?: (failure: FollowUpFailureReason) => void,
): Promise<boolean> {
  const result = await resumeStream(streamId, options);
  if ('started' in result) return result.delivered;
  if (options.isCancellationRequested?.() === true) return false;

  onRefused?.(result.failed);
  const session = options.session ?? defaultSession();
  await session.interactions.emit(
    'requestShowInstruction',
    {
      key: 'resumeRefused',
      message: describeFollowUpFailure(result.failed),
      showSuppress: false,
    },
    { replayWhenAttached: true },
  );
  return false;
}
