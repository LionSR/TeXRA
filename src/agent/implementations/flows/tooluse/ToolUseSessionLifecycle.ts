import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

export interface IToolUseSession {
  appendFollowUp(text: string): void;
  hasQueuedFollowUp(): boolean;
  /** Wait for the next follow-up items. Returns null if interrupted. */
  waitForFollowUp(checkInterruption: () => boolean): Promise<string[] | null>;
}

export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps = ToolUseFollowUpQueue.acquire(this.streamTabId);

  constructor(private readonly streamTabId: StreamTabId) {}

  appendFollowUp(text: string): void {
    this.followUps.enqueue(text);
  }

  hasQueuedFollowUp(): boolean {
    return !this.followUps.isEmpty();
  }

  async waitForFollowUp(
    checkInterruption: () => boolean,
  ): Promise<string[] | null> {
    return this.followUps.waitAndDrainAll(checkInterruption);
  }

  interrupt(): void {
    this.followUps.dispose();
  }

  dispose(): void {
    ToolUseFollowUpQueue.release(this.streamTabId);
  }
}
