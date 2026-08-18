/**
 * The one delivery path for detached live notifications.
 *
 * Producers that fire outside a model turn — execution-status subscriptions,
 * GitHub polling sources — share the same sequence: submit as a
 * `live_notification` fenced to the continuation generation the producer was
 * bound in, refresh the queued-follow-up view once the delivery lands, and warn
 * instead of leaking an unhandled rejection when it does not. Only the failure
 * message and its data belong to the producer.
 */

import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { submitFollowUp } from './ToolUseFollowUp';
import type { FollowUpQueueInput } from './FollowUpQueue';

export function deliverLiveNotification(delivery: {
  readonly streamId: StreamTabId;
  readonly followUp: FollowUpQueueInput | string;
  /**
   * Session captured when the producer was bound: it fires from a timer or
   * listener where the run's AsyncLocalStorage is empty, so the owning session
   * must travel with the notification rather than be re-derived at delivery.
   */
  readonly session?: SessionHandle;
  /** Continuation generation the producer was bound in. */
  readonly expectedGenerationId?: string;
  readonly logger: {
    warn(message: string, options?: { data?: unknown }): void;
  };
  readonly failure: {
    readonly message: string;
    readonly data: Record<string, unknown>;
  };
}): void {
  const { streamId, session } = delivery;
  void submitFollowUp(streamId, delivery.followUp, {
    session,
    mode: 'live_notification',
    expectedGenerationId: delivery.expectedGenerationId,
  })
    .then((result) => {
      if (result.status !== 'sent' && result.status !== 'queued') return;
      (session ?? currentSession()).events.emit({
        scope: 'session',
        event: { type: 'updateQueuedFollowUps', payload: { streamId } },
      });
    })
    .catch((err: unknown) => {
      delivery.logger.warn(delivery.failure.message, {
        data: { ...delivery.failure.data, err },
      });
    });
}
