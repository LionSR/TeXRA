// Local imports - agent state
import type { AgentSharedStore } from './AgentSharedStore';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

interface RegistryEntry {
  streamId: StreamTabId;
  executionId: ExecutionId;
  store: AgentSharedStore;
}

class SharedStoreRegistry {
  private readonly byExecution = new Map<ExecutionId, RegistryEntry>();
  private readonly byStream = new Map<StreamTabId, RegistryEntry>();

  register(entry: RegistryEntry): void {
    this.byExecution.set(entry.executionId, entry);
    this.byStream.set(entry.streamId, entry);
  }

  unregisterByExecution(executionId: ExecutionId): void {
    const entry = this.byExecution.get(executionId);
    if (!entry) {
      return;
    }
    this.byExecution.delete(executionId);
    this.byStream.delete(entry.streamId);
  }

  unregisterByStream(streamId: StreamTabId): void {
    const entry = this.byStream.get(streamId);
    if (!entry) {
      return;
    }
    this.byStream.delete(streamId);
    this.byExecution.delete(entry.executionId);
  }

  getByStream(streamId: StreamTabId): AgentSharedStore | undefined {
    return this.byStream.get(streamId)?.store;
  }

  getByExecution(executionId: ExecutionId): AgentSharedStore | undefined {
    return this.byExecution.get(executionId)?.store;
  }

  clear(): void {
    this.byExecution.clear();
    this.byStream.clear();
  }
}

const registry = new SharedStoreRegistry();

export const AgentSharedStoreRegistry = {
  register(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void {
    registry.register({ streamId, executionId, store });
  },
  unregisterByExecution(executionId: ExecutionId): void {
    registry.unregisterByExecution(executionId);
  },
  unregisterByStream(streamId: StreamTabId): void {
    registry.unregisterByStream(streamId);
  },
  getByStream(streamId: StreamTabId): AgentSharedStore | undefined {
    return registry.getByStream(streamId);
  },
  getByExecution(executionId: ExecutionId): AgentSharedStore | undefined {
    return registry.getByExecution(executionId);
  },
  clear(): void {
    registry.clear();
  },
};
