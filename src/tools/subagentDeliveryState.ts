// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

/**
 * Per-execution delivery gate for subagent result routing.
 *
 * `hasDelivered` prevents duplicate delivery of the same result via both
 * `onBeforeWaiting` and `onCompleted`. Accepted follow-ups mark delivery
 * pending immediately so interrupts before consumption still report back;
 * consuming a follow-up keeps the next cycle pending for `onBeforeWaiting`.
 */
export interface SubagentDeliveryState {
  hasDelivered: boolean;
}

export const SUBAGENT_DELIVERY_DECISION = {
  AlreadyDelivered: 'already-delivered',
  MissingStream: 'missing-stream',
  Deliver: 'deliver',
} as const;

export type SubagentDeliveryDecision =
  (typeof SUBAGENT_DELIVERY_DECISION)[keyof typeof SUBAGENT_DELIVERY_DECISION];

export function resolveSubagentBeforeWaitingDelivery(
  deliveryState: SubagentDeliveryState,
  childStreamId: StreamTabId | undefined,
): SubagentDeliveryDecision {
  if (deliveryState.hasDelivered) {
    return SUBAGENT_DELIVERY_DECISION.AlreadyDelivered;
  }
  if (!childStreamId) {
    return SUBAGENT_DELIVERY_DECISION.MissingStream;
  }
  return SUBAGENT_DELIVERY_DECISION.Deliver;
}
