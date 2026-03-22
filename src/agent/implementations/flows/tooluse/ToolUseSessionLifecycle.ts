import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { FollowUpItem } from '@agent/toolUse/FollowUpQueue';
import type { StreamTabId } from '@shared/schemas';

export interface IToolUseSession {
  appendFollowUp(item: FollowUpItem): void;
  appendFollowUpText(text: string): void;
  hasQueuedFollowUp(): boolean;
  /** Wait for the next follow-up items. Returns null if interrupted. */
  waitForFollowUp(
    checkInterruption: () => boolean,
  ): Promise<FollowUpItem[] | null>;
}

export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps = ToolUseFollowUpQueue.acquire(this.streamTabId);

  constructor(private readonly streamTabId: StreamTabId) {}

  appendFollowUp(item: FollowUpItem): void {
    this.followUps.enqueue(item);
  }

  appendFollowUpText(text: string): void {
    this.followUps.enqueueText(text);
  }

  hasQueuedFollowUp(): boolean {
    return !this.followUps.isEmpty();
  }

  async waitForFollowUp(
    checkInterruption: () => boolean,
  ): Promise<FollowUpItem[] | null> {
    return this.followUps.waitAndDrainAll(checkInterruption);
  }

  interrupt(): void {
    this.followUps.cancelWait();
    this.followUps.clear();
  }

  dispose(): void {
    ToolUseFollowUpQueue.release(this.streamTabId);
  }
}
