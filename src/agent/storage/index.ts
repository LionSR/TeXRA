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
  buildCliWorkflowResultMeta,
  unwrapResultMeta,
  type ResultMeta,
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
  writeWorkflowExecutionSnapshot,
} from './executionLifecycle';
export {
  type AgentExecutionListingEntry,
  type ExecutionListingEntry,
  listExecutions,
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
export { formatConversationMessage } from './conversationFormat';
export {
  completeOwnedExecutionLease,
  ExecutionLeaseLostError,
  inspectExecutionLease,
  markOwnedExecutionLeaseUndurable,
  type OwnedExecutionLeaseScope,
} from './executionLease';
export { resolveChildRunOutput } from './childRunOutput';
export {
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from './SessionStores';
