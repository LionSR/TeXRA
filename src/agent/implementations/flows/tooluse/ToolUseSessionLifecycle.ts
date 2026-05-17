import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { FollowUpQueueBatch } from '@agent/toolUse/FollowUpQueue';
import type { StreamTabId } from '@shared/schemas';

export interface IToolUseSession {
  appendFollowUp(text: string): void;
  appendSyntheticFollowUp(text: string): void;
  hasQueuedFollowUp(): boolean;
  /** Wait for the next follow-up items. Returns null if interrupted. */
  waitForFollowUp(
    checkInterruption: () => boolean,
  ): Promise<FollowUpQueueBatch | null>;
}

export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps = ToolUseFollowUpQueue.acquire(this.streamTabId);
  private syntheticFollowUpPending = false;

  constructor(private readonly streamTabId: StreamTabId) {}

  appendFollowUp(text: string): void {
    this.followUps.enqueue(text);
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

  dispose(): void {
    ToolUseFollowUpQueue.release(this.streamTabId);
  }
}
