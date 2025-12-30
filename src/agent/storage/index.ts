/**
 * Execution storage module.
 *
 * Provides unified key-value storage for all execution-scoped data.
 */

export {
  type ExecutionKVStore,
  type ExecutionStorageRegistry,
  InMemoryKVStore,
  InMemoryRegistry,
  getExecutionRegistry,
  getExecutionStore,
  setExecutionRegistry,
} from './ExecutionKVStore';
