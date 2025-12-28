/**
 * ToolUseSessionLifecycle - Unified session lifecycle for tool-use flows.
 *
 * This module provides the session lifecycle implementation that works with
 * any IToolUseSessionHost, enabling both agent-based and flow-first execution.
 */

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';

import { ToolUseSessionPersistence } from '@agent/toolUse/ToolUseSessionPersistence';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS } from '@common/constants/streamStatus';

/**
 * Interface for tool-use session lifecycle operations.
 * Exposes session-related methods that flows and external callers need.
 */
export interface IToolUseSession {
  /** Append a follow-up message to the session queue. */
  appendFollowUp(text: string): void;

  /** Check if there's a queued follow-up message. */
  hasQueuedFollowUp(): boolean;

  /** Wait for the next follow-up message. Returns null if interrupted. */
  waitForFollowUp(checkInterruption: () => boolean): Promise<string | null>;

  /** Clear any persisted snapshot state. */
  clearPersistedSnapshot(): Promise<void>;

  /** Enter waiting state for follow-up messages. */
  enterWaitingState(messages: ProviderMessage[]): Promise<void>;

  /** Mark the session as running (resume from waiting). */
  markRunning(): Promise<void>;

  /** Persist a checkpoint of the current session state. */
  persistCheckpoint(messages: ProviderMessage[]): Promise<void>;
}

/**
 * Interface for what the session lifecycle needs from its host.
 *
 * Implemented by ToolUseFlowContext to provide session lifecycle with
 * necessary context for flow-first execution.
 */
export interface IToolUseSessionHost {
  readonly streamTabId: StreamTabId;
  readonly executionId: ExecutionId | undefined;
  readonly config: AgentConfig;
}

/**
 * Session lifecycle that works with any IToolUseSessionHost.
 *
 * Provides unified session management for flow-first execution.
 */
export class ToolUseSessionLifecycle implements IToolUseSession {
  private readonly followUps: FollowUpQueue;
  private store: AgentSharedStore | null = null;

  constructor(private readonly host: IToolUseSessionHost) {
    this.followUps = ToolUseFollowUpQueue.acquire(host.streamTabId);
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

  /**
   * Builds persistence args if store and executionId are available.
   * Returns null if state is invalid for persistence.
   */
  private buildPersistenceArgs(messages: ProviderMessage[]) {
    const store = this.store;
    const executionId = this.host.executionId;
    if (!store || !executionId) {
      return null;
    }
    return {
      executionId,
      streamId: this.host.streamTabId,
      agentConfig: this.host.config,
      messages,
      store,
      queue: this.followUps,
    };
  }

  async enterWaitingState(messages: ProviderMessage[]): Promise<void> {
    if (!this.followUps.isEmpty()) {
      return;
    }

    const args = this.buildPersistenceArgs(messages);
    if (!args) {
      // Preconditions not met (no store or executionId) - don't set waiting status
      return;
    }

    // Attempt to persist idle snapshot (best effort, non-blocking)
    await ToolUseSessionPersistence.maybePersistIdleSnapshot(args);

    // Set waiting status after successful persistence setup
    StreamStatusService.set(this.host.streamTabId, STREAM_STATUS.WAITING);
  }

  async markRunning(): Promise<void> {
    StreamStatusService.set(this.host.streamTabId, STREAM_STATUS.RUNNING);
  }

  async clearPersistedSnapshot(): Promise<void> {
    await ToolUseSessionPersistence.clearPersistedSnapshot(
      this.host.executionId,
    );
  }

  async persistCheckpoint(messages: ProviderMessage[]): Promise<void> {
    const args = this.buildPersistenceArgs(messages);
    if (!args) {
      return;
    }
    await ToolUseSessionPersistence.persistCheckpointSnapshot(args);
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
    ToolUseFollowUpQueue.release(this.host.streamTabId);
    // Clear any cached snapshot to prevent memory leaks
    ToolUseSessionManager.clearByStream(this.host.streamTabId);
  }
}
