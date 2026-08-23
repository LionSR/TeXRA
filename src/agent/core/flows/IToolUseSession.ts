import type {
  FollowUpQueueBatch,
  FollowUpQueueInput,
} from '@agent/followUp/FollowUpQueue';

/** Contract for injecting queued user messages into an active tool-use cycle. */
export interface IToolUseSession {
  appendFollowUp(followUp: FollowUpQueueInput): void;
  appendSyntheticFollowUp(text: string): void;
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
