import type { FollowUpQueueBatch } from '@agent/followUp/FollowUpQueue';

/**
 * Contract for reading queued user messages inside an active tool-use cycle.
 * Producers put input in through the session's follow-up queue
 * (`SessionHandle.followUps`), never through this consumer surface.
 */
export interface IToolUseSession {
  hasQueuedFollowUp(): boolean;
  /** Wait for the next follow-up items. Returns null if interrupted. */
  waitForFollowUp(signal: AbortSignal): Promise<FollowUpQueueBatch | null>;
  /**
   * Record that the parking wait ended because the queue was taken away (not
   * by a run abort). The flow reads this to end the run as cancelled, never
   * as completed.
   */
  noteParkedWaitCancelled(): void;
}
