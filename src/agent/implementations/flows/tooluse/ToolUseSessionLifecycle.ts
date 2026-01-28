/**
 * ToolUseSessionLifecycle - Session lifecycle for tool-use flows.
 *
 * Provides follow-up queue management and stream status updates.
 */

import { STREAM_STATUS } from '@shared/schemas';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { StreamTabId } from '@shared/schemas';

/** Interface for tool-use session lifecycle operations (follow-ups, stream status). */
export interface IToolUseSession {
  appendFollowUp(text: string): void;
  hasQueuedFollowUp(): boolean;
  /** Wait for the next follow-up message. Returns null if interrupted. */
  waitForFollowUp(checkInterruption: () => boolean): Promise<string | null>;
  enterWaitingState(): Promise<void>;
  markRunning(): Promise<void>;
}

/** Session lifecycle implementation managing follow-up queue and stream status. */
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

  async enterWaitingState(): Promise<void> {
    if (this.followUps.isEmpty()) {
      StreamStatusService.set(this.streamTabId, STREAM_STATUS.WAITING);
    }
  }

  async markRunning(): Promise<void> {
    StreamStatusService.set(this.streamTabId, STREAM_STATUS.RUNNING);
  }

  interrupt(): void {
    this.followUps.cancelWait();
    this.followUps.clear();
  }

  dispose(): void {
    ToolUseFollowUpQueue.release(this.streamTabId);
  }
}
