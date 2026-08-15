/**
 * Agent storage — the cross-host public surface of `src/agent/storage`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each storage module by path. Beyond unified key-value storage
 * for execution-scoped data, this is the curated host boundary for execution
 * lifecycle and listing, resumability, the `executionLease` lifecycle, and
 * conversation formatting — decoupling host code from the storage internals'
 * file layout, per the module-level barrel pattern set by `@agent/runtime`
 * (#10011). The R-b deep-import width ratchet
 * (`config/ratchets/host-agent-import-baseline.json`) collapses each host's
 * many `@agent/storage/*` specifiers to this single door.
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
  createLatexExecutionDiscovery,
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
