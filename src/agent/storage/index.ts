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
  registerExecution,
  synchronizeAgentResultOutcome,
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
  writeSessionDescription,
} from './executionLifecycle';
export {
  type ExecutionListingEntry,
  type DeleteExecutionOptions,
  type DeleteExecutionResult,
  listExecutions,
  deleteExecution,
  deleteAllExecutions,
  isUserVisibleExecution,
} from './executionListing';
export {
  HEARTBEAT_INTERVAL_MS,
  describeHeartbeatOwner,
  getExecutionLiveness,
  setHeartbeatOwnerHost,
  touchExecutionHeartbeat,
} from './executionLiveness';
export {
  RESUMABILITY_CAUSE,
  deriveResumability,
  type ResumabilityDecision,
} from './resumability';
export { resolveChildRunOutput } from './childRunOutput';
export {
  releaseOwnedExecutionLease,
  releaseOwnedExecutionLeaseBestEffort,
  waitForOwnedExecutionLeaseRelease,
} from './executionLease';
