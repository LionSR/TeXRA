/**
 * AgentSharedStoreRegistry - Registry for AgentSharedStore Instances
 *
 * This module manages the mapping between stream/execution IDs and their
 * associated AgentSharedStore instances.
 *
 * ## PocketFlow Best Practices Applied:
 *
 * 1. **Lifecycle Management**: Added dispose() and size for proper cleanup
 * 2. **Injectable Interface**: ISharedStoreRegistry allows for mocking
 * 3. **Single Source of Truth**: Centralized store lookup
 * 4. **Backward Compatible**: Existing API preserved for gradual migration
 *
 * ## Usage
 *
 * ```typescript
 * // Register a store
 * AgentSharedStoreRegistry.register(streamId, executionId, store);
 *
 * // Lookup by stream or execution
 * const store = AgentSharedStoreRegistry.getByStream(streamId);
 *
 * // Cleanup
 * AgentSharedStoreRegistry.unregisterByExecution(executionId);
 * ```
 */

// Local imports - agent state
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local file imports
import { StreamExecutionIndex } from './StreamExecutionIndex';

// Type imports
import type { AgentSharedStore } from './AgentSharedStore';

/**
 * Interface for shared store registry.
 * Allows for dependency injection and mocking in tests.
 */
export interface ISharedStoreRegistry {
  register(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void;
  set(
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
    store: AgentSharedStore | null,
  ): void;
  unregisterByExecution(executionId: ExecutionId): void;
  unregisterByStream(streamId: StreamTabId): void;
  getByStream(streamId: StreamTabId): AgentSharedStore | undefined;
  getByExecution(executionId: ExecutionId): AgentSharedStore | undefined;
  clear(): void;
  readonly size: number;
}

/**
 * Type for lifecycle hooks that can be registered with the registry.
 */
export type StoreLifecycleHook = (
  streamId: StreamTabId,
  executionId: ExecutionId,
  store: AgentSharedStore,
) => void;

class SharedStoreRegistry implements ISharedStoreRegistry {
  private readonly index = new StreamExecutionIndex<AgentSharedStore>();
  private readonly onRegisterHooks: StoreLifecycleHook[] = [];
  private readonly onUnregisterHooks: StoreLifecycleHook[] = [];

  /**
   * Add a hook to be called when a store is registered.
   */
  addOnRegisterHook(hook: StoreLifecycleHook): () => void {
    this.onRegisterHooks.push(hook);
    return () => {
      const idx = this.onRegisterHooks.indexOf(hook);
      if (idx >= 0) this.onRegisterHooks.splice(idx, 1);
    };
  }

  /**
   * Add a hook to be called when a store is unregistered.
   */
  addOnUnregisterHook(hook: StoreLifecycleHook): () => void {
    this.onUnregisterHooks.push(hook);
    return () => {
      const idx = this.onUnregisterHooks.indexOf(hook);
      if (idx >= 0) this.onUnregisterHooks.splice(idx, 1);
    };
  }

  register(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void {
    this.index.set(streamId, executionId, store);
    for (const hook of this.onRegisterHooks) {
      hook(streamId, executionId, store);
    }
  }

  set(
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
    store: AgentSharedStore | null,
  ): void {
    if (!executionId) {
      return;
    }
    if (!store) {
      this.unregisterByExecution(executionId);
      this.unregisterByStream(streamId);
      return;
    }
    this.register(streamId, executionId, store);
  }

  unregisterByExecution(executionId: ExecutionId): void {
    const entry = this.index.deleteByExecution(executionId);
    if (entry) {
      for (const hook of this.onUnregisterHooks) {
        hook(entry.streamId, entry.executionId, entry.value);
      }
    }
  }

  unregisterByStream(streamId: StreamTabId): void {
    const entry = this.index.deleteByStream(streamId);
    if (entry) {
      for (const hook of this.onUnregisterHooks) {
        hook(entry.streamId, entry.executionId, entry.value);
      }
    }
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

  get size(): number {
    return this.index.size;
  }

  /**
   * Dispose the registry and remove all hooks.
   */
  dispose(): void {
    this.clear();
    this.onRegisterHooks.length = 0;
    this.onUnregisterHooks.length = 0;
  }
}

const registry = new SharedStoreRegistry();

/**
 * Global AgentSharedStoreRegistry singleton.
 *
 * For new code, prefer injecting ISharedStoreRegistry via dependency injection.
 * This global is retained for backward compatibility.
 */
export const AgentSharedStoreRegistry = {
  register(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void {
    registry.register(streamId, executionId, store);
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
  get size(): number {
    return registry.size;
  },
  /**
   * Add a lifecycle hook for store registration.
   * Returns a dispose function to remove the hook.
   */
  addOnRegisterHook(hook: StoreLifecycleHook): () => void {
    return registry.addOnRegisterHook(hook);
  },
  /**
   * Add a lifecycle hook for store unregistration.
   * Returns a dispose function to remove the hook.
   */
  addOnUnregisterHook(hook: StoreLifecycleHook): () => void {
    return registry.addOnUnregisterHook(hook);
  },
  /**
   * Dispose the registry (clears all stores and hooks).
   */
  dispose(): void {
    registry.dispose();
  },
};
