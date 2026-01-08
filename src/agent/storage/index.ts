/**
 * Execution storage module.
 *
 * Provides unified key-value storage for all execution-scoped data.
 */

export { type ExecutionKVStore, getExecutionStore } from './ExecutionKVStore';
export {
  detectWaitingStreams,
  hasPersistedFlowRecord,
} from './detectWaitingStreams';
