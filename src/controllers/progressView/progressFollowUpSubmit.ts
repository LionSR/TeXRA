import {
  presentFollowUpResult,
  submitFollowUp,
  type SubmitFollowUpResult,
} from '@agent/followUp';
import type { SessionHandle } from '@agent/runtime';
import type { FollowUpQueueInput } from '@agent/followUp';
import { createLog } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('ProgressFollowUpSubmit');

const NO_ACTIVE_SESSION_MESSAGE =
  'No active session. Start a new agent task to continue.';

export interface ProgressFollowUpSubmitArgs {
  readonly session: SessionHandle;
  readonly streamId: StreamTabId;
  readonly input: FollowUpQueueInput;
  /**
   * Admission ack for the composer that sent this. Fires exactly once, as
   * soon as admission is decided and before any recovery resume runs, so a
   * refused draft is handed back without waiting on a model turn.
   */
  readonly acknowledge: (accepted: boolean) => void;
  readonly showInfo: (message: string) => void | PromiseLike<unknown>;
}

/**
 * One follow-up submission path for the extension and desktop progress views:
 * waiting repair, admission, the composer ack, the queued-follow-ups refresh,
 * and outcome presentation. Hosts supply only their ports.
 */
export async function submitProgressFollowUp(
  args: ProgressFollowUpSubmitArgs,
): Promise<void> {
  const { session, streamId, input, showInfo } = args;
  let acknowledged = false;
  const acknowledge = (accepted: boolean): void => {
    if (acknowledged) return;
    acknowledged = true;
    args.acknowledge(accepted);
  };
  const emitQueuedFollowUpsChanged = (): void => {
    session.events.emit({
      scope: 'session',
      event: { type: 'updateQueuedFollowUps', payload: { streamId } },
    });
  };

  let result: SubmitFollowUpResult;
  try {
    await session.repairWaitingIfResumable(streamId);
    result = await submitFollowUp(streamId, input, {
      session,
      onAdmitted: acknowledge,
    });
  } catch (error) {
    acknowledge(false);
    const message = toErrorMessage(error);
    logger.warn(
      `Failed to submit follow-up for stream ${streamId}: ${message}`,
      {
        data: { streamId, error: message },
      },
    );
    await showInfo(`Could not send the follow-up: ${message}`);
    return;
  }

  switch (result.status) {
    case 'sent':
      acknowledge(true);
      emitQueuedFollowUpsChanged();
      return;
    case 'queued': {
      acknowledge(true);
      emitQueuedFollowUpsChanged();
      const presentation = presentFollowUpResult(result);
      if (presentation.severity !== 'none') {
        await showInfo(presentation.message);
      }
      return;
    }
    case 'duplicate':
      acknowledge(true);
      return;
    case 'no_session':
    case 'dropped':
      acknowledge(false);
      await showInfo(NO_ACTIVE_SESSION_MESSAGE);
      return;
  }
}
