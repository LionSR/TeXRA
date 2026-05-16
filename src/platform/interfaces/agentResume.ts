import type { StreamTabId } from '@shared/schemas';

/**
 * Host capability for resuming an agent stream from its persisted snapshot.
 *
 * Implemented by the VS Code host (and any other host) so VS Code-free code
 * (e.g. the inquiry continuation injector) can trigger auto-resume without
 * importing the host-level command pipeline.
 */
export interface AgentResumePort {
  /**
   * Attempt to resume a WAITING / children-running stream from its
   * persisted snapshot. Returns true if the host accepted the request
   * (i.e. the resume command dispatched successfully).
   *
   * Returns false if the stream cannot be resumed (no snapshot found,
   * already active/resuming, etc.) — callers should fall back to leaving
   * the message queued for the next manual resume.
   */
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
}
