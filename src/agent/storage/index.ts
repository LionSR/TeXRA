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
export {
  type TodoEntry,
  type ChildRecord,
  type ExecutionMeta,
  readTodos,
  readConversation,
  readReport,
  readMeta,
  readConfig,
  readChildren,
  registerExecution,
  writeTerminalStatus,
} from './executionReaders';
export {
  type ExecutionListingEntry,
  listExecutions,
  invalidateListingCache,
  deleteExecution,
  deleteAllExecutions,
} from './executionListing';
