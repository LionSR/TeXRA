import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import type {
  FollowUpQueueBatch,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';
import type { IToolUseSession } from '@agent/core/flows/IToolUseSession';
import type { StreamTabId } from '@shared/schemas';

export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps = ToolUseFollowUpQueue.acquire(this.streamTabId);
  private syntheticFollowUpPending = false;

  constructor(private readonly streamTabId: StreamTabId) {}

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

  dispose(): void {
    ToolUseFollowUpQueue.release(this.streamTabId);
  }
}
