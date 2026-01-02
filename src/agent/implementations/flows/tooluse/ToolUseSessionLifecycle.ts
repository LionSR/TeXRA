/**
 * ToolUseSessionLifecycle - Session lifecycle for tool-use flows.
 *
 * Provides follow-up queue management and stream status updates.
 */

import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

import { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@common/constants/streamStatus';

/**
 * Interface for tool-use session lifecycle operations.
 * Exposes session-related methods that flows and external callers need.
 *
 * Note: Persistence is handled automatically by PersistedFlow.
 * This interface focuses on session-specific operations (follow-ups, status).
 */
export interface IToolUseSession {
  /** Set the shared store for session state management. */
  setStore(store: AgentSharedStore | null): void;

  /** Append a follow-up message to the session queue. */
  appendFollowUp(text: string): void;

  /** Check if there's a queued follow-up message. */
  hasQueuedFollowUp(): boolean;

  /** Wait for the next follow-up message. Returns null if interrupted. */
  waitForFollowUp(checkInterruption: () => boolean): Promise<string | null>;

  /** Enter waiting state for follow-up messages. */
  enterWaitingState(): Promise<void>;

  /** Mark the session as running (resume from waiting). */
  markRunning(): Promise<void>;
}

/**
 * Session lifecycle for tool-use flows.
 *
 * Provides unified session management for flow-first execution.
 * Only requires streamTabId - other context is accessed via services.
 */
export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps: FollowUpQueue;
  private store: AgentSharedStore | null = null;

  constructor(private readonly streamTabId: StreamTabId) {
    this.followUps = ToolUseFollowUpQueue.acquire(streamTabId);
  }

  setStore(store: AgentSharedStore | null): void {
    this.store = store;
  }

  getStore(): AgentSharedStore | null {
    return this.store;
  }

  appendFollowUp(text: string): void {
    this.followUps.enqueue(text);
  }

  hasQueuedFollowUp(): boolean {
    return !this.followUps.isEmpty();
  }

  async waitForFollowUp(
    checkInterruption: () => boolean,
  ): Promise<string | null> {
    return this.followUps.waitForNext(checkInterruption);
  }

  async enterWaitingState(): Promise<void> {
    if (!this.followUps.isEmpty()) {
      return;
    }

    // PersistedFlow handles state persistence automatically after each node.
    // We only need to set the UI status here.
    StreamStatusService.set(this.streamTabId, STREAM_STATUS.WAITING);
  }

  async markRunning(): Promise<void> {
    StreamStatusService.set(this.streamTabId, STREAM_STATUS.RUNNING);
  }

  /**
   * Called when session is interrupted.
   */
  interrupt(): void {
    this.followUps.cancelWait();
    this.followUps.clear();
  }

  /**
   * Dispose resources when context is cleaned up.
   */
  dispose(): void {
    this.setStore(null);
    ToolUseFollowUpQueue.release(this.streamTabId);
    // PersistedFlow handles state cleanup automatically.
  }
}
