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
 * admission, the composer ack, the queued-follow-ups refresh, and outcome
 * presentation. Hosts supply only their ports. A stream with no live flow in
 * this process refuses the draft with a worded reason.
 *
 * Resolves at admission with whether the draft was accepted. Anything after
 * admission (a recovery resume may run a whole model turn, then present its
 * outcome) runs detached so no IPC request or window close waits on it.
 */
export function submitProgressFollowUp(
  args: ProgressFollowUpSubmitArgs,
): Promise<boolean> {
  const { session, streamId, input, showInfo } = args;
  return new Promise<boolean>((resolveAdmission) => {
    let acknowledged = false;
    const acknowledge = (accepted: boolean): void => {
      if (acknowledged) return;
      acknowledged = true;
      try {
        args.acknowledge(accepted);
      } finally {
        resolveAdmission(accepted);
      }
    };
    const emitQueuedFollowUpsChanged = (): void => {
      session.events.emit({
        scope: 'session',
        event: { type: 'updateQueuedFollowUps', payload: { streamId } },
      });
    };

    void (async () => {
      let result: SubmitFollowUpResult;
      try {
        result = await submitFollowUp(streamId, input, {
          session,
          onAdmitted: acknowledge,
        });
      } catch (error) {
        acknowledge(false);
        const message = toErrorMessage(error);
        logger.warn(
          `Failed to submit follow-up for stream ${streamId}: ${message}`,
          { data: { streamId, error: message } },
        );
        await showInfo(`Could not send the follow-up: ${message}`);
        return;
      }

      // A failed recovery resume still queued the input; every other
      // failure hands the draft back.
      acknowledge(
        result.status !== 'failed' || result.reason === 'resume_failed',
      );
      emitQueuedFollowUpsChanged();
      const presentation = presentFollowUpResult(result);
      if (presentation.severity !== 'none') {
        await showInfo(presentation.message);
      }
    })().catch((error: unknown) => {
      acknowledge(false);
      logger.warn(
        `Follow-up presentation failed for stream ${streamId}: ${toErrorMessage(error)}`,
      );
    });
  });
}
