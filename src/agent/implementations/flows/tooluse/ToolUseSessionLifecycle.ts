import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type {
  FollowUpQueueBatch,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { StreamTabId } from '@shared/schemas';

export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps = this.queue.acquire(this.streamTabId);
  private syntheticFollowUpPending = false;

  constructor(
    private readonly streamTabId: StreamTabId,
    private readonly queue: ToolUseFollowUpQueue,
  ) {}

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
    checkInterruption: () => boolean,
  ): Promise<FollowUpQueueBatch | null> {
    const batch = await this.followUps.waitAndDrainAll(checkInterruption);
    if (batch?.synthetic) {
      this.syntheticFollowUpPending = false;
    }
    return batch;
  }

  interrupt(): void {
    this.syntheticFollowUpPending = false;
    this.followUps.dispose();
  }

  /**
   * Same wake-up as `interrupt()` (unblock any in-progress `waitForFollowUp`)
   * but, unlike it, does not drop already-queued items. For the narrow window
   * during resume startup where a caller (`resumeQueuedToolUseSnapshot`'s
   * `setupSession`) has just re-appended its drained follow-up batch into
   * this queue before the flow is interruptible: an async cancellation
   * landing in that window must not erase that batch, since the flow's own
   * early-cancel branch preserves the resume record for a later replay (see
   * `runToolUseFlow`'s `preserveResumeRecord` finally guard, which also
   * skips releasing this queue in that case). Every other cancellation path
   * keeps using `interrupt()`'s destructive clear.
   */
  interruptPreservingQueue(): void {
    this.syntheticFollowUpPending = false;
    this.followUps.cancelWait();
  }

  dispose(): void {
    this.queue.release(this.streamTabId);
  }
}
