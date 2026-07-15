/**
 * Execution storage module.
 *
 * Provides unified key-value storage for all execution-scoped data.
 */

export {
  EXECUTION_META_SCHEMA_VERSION,
  type ExecutionKVStore,
  type ExecutionMeta,
  type TodoEntry,
  type ChildRecord,
  getExecutionStore,
  clearStoreCache,
  isReservedKvKeyName,
} from './ExecutionKVStore';
export {
  buildCliWorkflowResultMeta,
  unwrapResultMeta,
  type ResultMeta,
  ResultMetaSchema,
} from './resultMeta';
export {
  listExecutionWorkspaceFiles,
  resolveExecutionWorkspaceFilePath,
} from './executionWorkspaceFiles';
export {
  finalizeExecution,
  hasPersistedParent,
  registerExecution,
  synchronizeAgentResultOutcome,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
  writeTerminalStatus,
  writeSessionDescription,
} from './executionLifecycle';
export {
  type ExecutionListingEntry,
  listExecutions,
  deleteExecution,
  deleteAllExecutions,
  isUserVisibleExecution,
} from './executionListing';
export {
  RESUMABILITY_CAUSE,
  deriveResumability,
  type ResumabilityDecision,
} from './resumability';
export { resolveChildRunOutput } from './childRunOutput';
