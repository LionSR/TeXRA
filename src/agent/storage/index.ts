/**
 * Execution storage module.
 *
 * Provides unified key-value storage for all execution-scoped data.
 */

export {
  type ExecutionKVStore,
  type TodoEntry,
  type ChildRecord,
  getExecutionStore,
  clearStoreCache,
  isReservedKvKeyName,
} from './ExecutionKVStore';
export {
  EXECUTION_META_SCHEMA_VERSION,
  type ExecutionMeta,
} from '@shared/schemas/stream';
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
  RESUMABILITY_CAUSE,
  deriveResumability,
  type ResumabilityDecision,
} from './resumability';
export { resolveChildRunOutput } from './childRunOutput';
export {
  acquireResumedExecutionLease,
  abandonOwnedExecutionLease,
  completeOwnedExecutionLease,
  markOwnedExecutionLeaseUndurable,
  releaseOwnedExecutionLeaseAfterFailure,
  ExecutionLeaseActiveError,
  ExecutionLeaseLostError,
  type OwnedExecutionLeaseScope,
} from './executionLease';
