/**
 * ToolUseSessionLifecycle - Follow-up queue management for tool-use flows.
 *
 * Handles follow-up message queueing, waiting, and interruption.
 * Stream status transitions are handled directly by flow nodes.
 */

import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';

/** Interface for tool-use session follow-up queue operations. */
export interface IToolUseSession {
  appendFollowUp(text: string): void;
  hasQueuedFollowUp(): boolean;
  /** Wait for the next follow-up message. Returns null if interrupted. */
  waitForFollowUp(checkInterruption: () => boolean): Promise<string | null>;
}

/** Session lifecycle implementation managing follow-up queue. */
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
  ): Promise<string | null> {
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
