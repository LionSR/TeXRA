// Type imports
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import { ToolUseSessionPersistence } from '@agent/toolUse/ToolUseSessionPersistence';
import { ToolUseSessionManager } from '@agent/toolUse/ToolUseSessionManager';
import {
  ToolUseFollowUpQueue,
  type FollowUpQueue,
} from '@agent/toolUse/ToolUseFollowUp';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
// Type imports
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';

// Internal imports
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

export class ToolUseSessionLifecycle<C = unknown> implements IToolUseSession {
  private readonly followUps: FollowUpQueue;
  private store: AgentSharedStore | null = null;

  constructor(private readonly agent: BaseToolUseAgent<C>) {
    this.followUps = ToolUseFollowUpQueue.acquire(agent.getStreamTabId());
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
    const executionId = this.agent.getExecutionId();
    if (!store || !executionId) {
      return null;
    }
    return {
      executionId,
      streamId: this.agent.getStreamTabId(),
      agentConfig: this.agent.config,
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
      // This can happen during interruption when store is cleared
      return;
    }

    // Attempt to persist idle snapshot (best effort, non-blocking)
    await ToolUseSessionPersistence.maybePersistIdleSnapshot(args);

    // Set waiting status after successful persistence setup
    StreamStatusService.set(this.agent.getStreamTabId(), STREAM_STATUS.WAITING);
  }

  async persistCheckpoint(messages: ProviderMessage[]): Promise<void> {
    const args = this.buildPersistenceArgs(messages);
    if (!args) {
      return;
    }
    await ToolUseSessionPersistence.persistCheckpointSnapshot(args);
  }

  async markRunning(): Promise<void> {
    StreamStatusService.set(this.agent.getStreamTabId(), STREAM_STATUS.RUNNING);
  }

  async clearPersistedSnapshot(): Promise<void> {
    await ToolUseSessionPersistence.clearPersistedSnapshot(
      this.agent.getExecutionId(),
    );
  }

  interrupt(): void {
    this.followUps.cancelWait();
    this.followUps.clear();
  }

  dispose(): void {
    this.setStore(null);
    ToolUseFollowUpQueue.release(this.agent.getStreamTabId());
    // Clear any cached snapshot to prevent memory leaks
    ToolUseSessionManager.clearByStream(this.agent.getStreamTabId());
  }
}
