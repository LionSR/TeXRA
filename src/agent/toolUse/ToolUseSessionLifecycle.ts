// Local imports - agent core
import { AgentSharedStoreRegistry } from '@agent/core/AgentSharedStoreRegistry';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { ToolUseSessionPersistence } from '@agent/toolUse/ToolUseSessionPersistence';
import { FollowUpQueue } from '@agent/toolUse/FollowUpQueue';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';

// Local imports - agent implementation
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';

export class ToolUseSessionLifecycle<C = unknown> {
  private readonly followUps = new FollowUpQueue();
  private store: AgentSharedStore | null = null;

  constructor(private readonly agent: BaseToolUseAgent<C>) {}

  setStore(store: AgentSharedStore | null): void {
    const streamId = this.agent.getStreamTabId();
    const executionId = this.agent.getExecutionId();

    if (this.store) {
      if (executionId) {
        AgentSharedStoreRegistry.unregisterByExecution(executionId);
      } else {
        AgentSharedStoreRegistry.unregisterByStream(streamId);
      }
    }

    this.store = store;

    if (store && executionId) {
      AgentSharedStoreRegistry.register(streamId, executionId, store);
    }
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

    await ToolUseSessionPersistence.maybePersistIdleSnapshot({
      executionId,
      streamId: this.agent.getStreamTabId(),
      agentConfig: this.agent.config,
      messages,
      store,
      queue: this.followUps,
    });

    StreamStatusService.set(this.agent.getStreamTabId(), 'waiting');
  }

  async markRunning(): Promise<void> {
    StreamStatusService.set(this.agent.getStreamTabId(), 'running');
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
    this.followUps.dispose();
    this.setStore(null);
  }
}
