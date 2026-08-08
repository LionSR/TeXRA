/**
 * Execution storage module.
 *
 * Provides unified key-value storage for all execution-scoped data.
 */

export {
  type ExecutionKVStore,
  type TodoEntry,
  type ChildRecord,
  type ChildTurnRef,
  type ChildTurnState,
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
  type FinalizeExecutionInput,
  type FinalizeExecutionResult,
  writeSessionDescription,
} from './executionLifecycle';
export {
  type AgentExecutionListingEntry,
  type ExecutionListingEntry,
  type DeleteExecutionOptions,
  type DeleteExecutionResult,
  listExecutions,
  listExecutionStreamReferences,
  deleteExecution,
  deleteAllExecutions,
  isAgentRunEntry,
  isUserVisibleExecution,
} from './executionListing';
export {
  RESUMABILITY_CAUSE,
  deriveResumability,
  type ResumabilityDecision,
} from './resumability';
export { resolveChildRunOutput } from './childRunOutput';
export {
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from './SessionStores';
