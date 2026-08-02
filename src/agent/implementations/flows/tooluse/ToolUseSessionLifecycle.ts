import {
  ToolUseFollowUpQueue,
  type FollowUpConsumerLease,
} from '@agent/followUp/ToolUseFollowUpQueueManager';
import type {
  FollowUpQueue,
  FollowUpQueueBatch,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { StreamTabId } from '@shared/schemas';

export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps: FollowUpQueue;
  private readonly lease: FollowUpConsumerLease | undefined;
  private syntheticFollowUpPending = false;

  constructor(
    private readonly streamTabId: StreamTabId,
    private readonly queue: ToolUseFollowUpQueue,
  ) {
    const lease = queue.claimLive(streamTabId, 'flow');
    if (lease) {
      this.lease = lease;
      this.followUps = queue.queue(lease);
      return;
    }
    // A native child loop owns continuation across all of its turns. Its inner
    // one-cycle flow uses that queue without becoming a second consumer.
    const childQueue = queue.externallyOwnedQueue(streamTabId);
    if (!childQueue) {
      throw new Error(
        `Follow-up continuation already has an owner for stream ${streamTabId}.`,
      );
    }
    this.followUps = childQueue;
  }

  appendFollowUp(followUp: FollowUpQueueInput): void {
    this.followUps.enqueue(followUp);
  }

  appendSyntheticFollowUp(text: string): void {
    if (this.syntheticFollowUpPending) return;
    this.syntheticFollowUpPending = true;
    this.followUps.enqueueSynthetic(text);
  }

  hasQueuedFollowUp(): boolean {
    return !this.followUps.isEmpty();
  }

  async waitForFollowUp(
    signal: AbortSignal,
  ): Promise<FollowUpQueueBatch | null> {
    const batch = await this.followUps.waitAndDrainAll(signal);
    if (batch?.synthetic) {
      this.syntheticFollowUpPending = false;
    }
    return batch;
  }

  /**
   * Cancel the in-flight follow-up wait. `queue: 'clear'` also drops queued
   * input, and is honored only while this flow holds the consumer lease: a
   * borrowed queue belongs to the outer child-loop or recovery consumer, which
   * owns the recoverable/terminal decision it applies at release. Callers pass
   * `'preserve'` for the one window they alone can see — a resume handoff that
   * is not yet interruptible.
   */
  interrupt(queue: 'clear' | 'preserve'): void {
    this.syntheticFollowUpPending = false;
    if (queue === 'clear' && this.lease) {
      this.followUps.dispose();
      return;
    }
    this.followUps.cancelWait();
  }

  release(next: 'recoverable' | 'terminal'): void {
    if (this.lease) this.queue.release(this.lease, next);
  }
}
