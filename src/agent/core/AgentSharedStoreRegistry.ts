// Local imports - agent state
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local file imports
import { StreamExecutionIndex } from './StreamExecutionIndex';

// Type imports
import type { AgentSharedStore } from './AgentSharedStore';

class SharedStoreRegistry {
  private readonly index = new StreamExecutionIndex<AgentSharedStore>();

  set(
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
    store: AgentSharedStore | null,
  ): void {
    if (!executionId) {
      return;
    }
    if (!store) {
      this.index.deleteByExecution(executionId);
      this.index.deleteByStream(streamId);
      return;
    }
    this.index.set(streamId, executionId, store);
  }

  unregisterByExecution(executionId: ExecutionId): void {
    this.index.deleteByExecution(executionId);
  }

  unregisterByStream(streamId: StreamTabId): void {
    this.index.deleteByStream(streamId);
  }

  getByStream(streamId: StreamTabId): AgentSharedStore | undefined {
    return this.index.getByStream(streamId);
  }

  getByExecution(executionId: ExecutionId): AgentSharedStore | undefined {
    return this.index.getByExecution(executionId);
  }

  clear(): void {
    this.index.clear();
  }
}

const registry = new SharedStoreRegistry();

export const AgentSharedStoreRegistry = {
  register(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void {
    registry.set(streamId, executionId, store);
  },
  set(
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
    store: AgentSharedStore | null,
  ): void {
    registry.set(streamId, executionId, store);
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
