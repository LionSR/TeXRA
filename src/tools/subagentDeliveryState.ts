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

  isDelivered(): boolean {
    return this.hasDelivered;
  }

  markPending(): void {
    this.hasDelivered = false;
  }

  markDelivered(): boolean {
    if (this.hasDelivered) return false;
    this.hasDelivered = true;
    return true;
  }

  resolveBeforeWaiting(
    childStreamId: StreamTabId | undefined,
  ): SubagentDeliveryDecision {
    if (this.hasDelivered) {
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

export const subagentDeliveryRegistry = new SubagentDeliveryRegistry();
