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
export class SubagentDeliveryState {
  private hasDelivered = false;
  private deliveryInFlight = false;

  isDelivered(): boolean {
    return this.hasDelivered;
  }

  markPending(): void {
    this.hasDelivered = false;
    this.deliveryInFlight = false;
  }

  markDelivered(): boolean {
    if (!this.beginDelivery()) return false;
    this.completeDelivery();
    return true;
  }

  beginDelivery(): boolean {
    if (this.hasDelivered || this.deliveryInFlight) return false;
    this.deliveryInFlight = true;
    return true;
  }

  completeDelivery(): void {
    this.hasDelivered = true;
    this.deliveryInFlight = false;
  }

  failDelivery(): void {
    this.deliveryInFlight = false;
  }

  resolveBeforeWaiting(
    childStreamId: StreamTabId | undefined,
  ): SubagentDeliveryDecision {
    if (this.hasDelivered || this.deliveryInFlight) {
      return SUBAGENT_DELIVERY_DECISION.AlreadyDelivered;
    }
    if (!childStreamId) {
      return SUBAGENT_DELIVERY_DECISION.MissingStream;
    }
    return SUBAGENT_DELIVERY_DECISION.Deliver;
  }
}

export class SubagentDeliveryRegistry {
  private readonly active = new Map<string, SubagentDeliveryState>();

  start(executionId: string): SubagentDeliveryState {
    const state = new SubagentDeliveryState();
    this.active.set(executionId, state);
    return state;
  }

  getActive(executionId: string): SubagentDeliveryState | undefined {
    return this.active.get(executionId);
  }

  finish(executionId: string): void {
    this.active.delete(executionId);
  }
}

export const SUBAGENT_DELIVERY_DECISION = {
  AlreadyDelivered: 'already-delivered',
  MissingStream: 'missing-stream',
  Deliver: 'deliver',
} as const;

export type SubagentDeliveryDecision =
  (typeof SUBAGENT_DELIVERY_DECISION)[keyof typeof SUBAGENT_DELIVERY_DECISION];

/**
 * Process-shared by design (SDK Step 7d): keyed by globally-unique executionId
 * with no cross-session sweep (`start`/`getActive`/`finish` touch one entry),
 * so concurrent delegations from different sessions never collide or wipe each
 * other — the same rationale as the shared `StreamStatusService`. Not composed
 * onto `SessionHandle`: a per-session split would be net-add with zero isolation
 * gain. Revisit only if a cross-session `clearAll`-style sweep is ever added.
 */
export const SharedSubagentDeliveryRegistry = new SubagentDeliveryRegistry();
