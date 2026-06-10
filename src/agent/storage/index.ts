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
  type ChildRecordData,
  type ResultMeta,
  getExecutionStore,
  clearStoreCache,
} from './ExecutionKVStore';
export {
  type ExecutionWorkspaceFile,
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
