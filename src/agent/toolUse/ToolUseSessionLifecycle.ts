// Local imports - agent core
import { AgentSharedStoreRegistry } from '@agent/core/AgentSharedStoreRegistry';
// Type imports
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import { ToolUseSessionPersistence } from '@agent/toolUse/ToolUseSessionPersistence';
// Type imports
import type { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
// Internal imports
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueue';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
// Type imports
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';

// Internal imports
import { STATUS } from '@progressView/modules/constants.js';

export class ToolUseSessionLifecycle<C = unknown> {
  private readonly followUps: FollowUpQueue;
  private store: AgentSharedStore | null = null;

  constructor(private readonly agent: BaseToolUseAgent<C>) {
    this.followUps = ToolUseFollowUpQueue.acquire(agent.getStreamTabId());
  }

  setStore(store: AgentSharedStore | null): void {
    const streamId = this.agent.getStreamTabId();
    const executionId = this.agent.getExecutionId();

    this.store = store;
    AgentSharedStoreRegistry.set(streamId, executionId, store);
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

  async enterWaitingState(messages: ProviderMessage[]): Promise<void> {
    if (!this.followUps.isEmpty()) {
      return;
    }

    const store = this.store;
    const executionId = this.agent.getExecutionId();
    if (!store || !executionId) {
      return;
    }

    // Attempt to persist idle snapshot (best effort, non-blocking)
    await ToolUseSessionPersistence.maybePersistIdleSnapshot({
      executionId,
      streamId: this.agent.getStreamTabId(),
      agentConfig: this.agent.config,
      messages,
      store,
      queue: this.followUps,
    });

    // Always set waiting status regardless of persistence result
    StreamStatusService.set(this.agent.getStreamTabId(), STATUS.WAITING);
  }

  async persistCheckpoint(messages: ProviderMessage[]): Promise<void> {
    const store = this.store;
    const executionId = this.agent.getExecutionId();
    if (!store || !executionId) {
      return;
    }

    await ToolUseSessionPersistence.persistCheckpointSnapshot({
      executionId,
      streamId: this.agent.getStreamTabId(),
      agentConfig: this.agent.config,
      messages,
      store,
      queue: this.followUps,
    });
  }

  async markRunning(): Promise<void> {
    StreamStatusService.set(this.agent.getStreamTabId(), STATUS.RUNNING);
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
  }
}
