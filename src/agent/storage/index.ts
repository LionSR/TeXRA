/**
 * Execution storage module.
 *
 * Provides unified key-value storage for all execution-scoped data.
 */

export {
  type ExecutionKVStore,
  type ExecutionMeta,
  type TodoEntry,
  type ChildRecord,
  type ResultMeta,
  ResultMetaSchema,
  getExecutionStore,
  clearStoreCache,
} from './ExecutionKVStore';
export {
  listExecutionWorkspaceFiles,
  resolveExecutionWorkspaceFilePath,
} from './executionWorkspaceFiles';
export {
  registerExecution,
  writeTerminalStatus,
  writeSessionDescription,
} from './executionLifecycle';
export {
  type ExecutionListingEntry,
  listExecutions,
  deleteExecution,
  deleteAllExecutions,
} from './executionListing';
