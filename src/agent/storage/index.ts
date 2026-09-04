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
 * (`config/ratchets/host-agent-import-baseline.json`) records the remaining
 * host `@agent/storage/*` specifiers — CLI's `conversationFormat` and
 * `executionLease` — collapsed to this single door.
 */

export {
  type ExecutionKVStore,
  type ChildRecord,
  getExecutionStore,
  clearStoreCache,
  isReservedKvKeyName,
  readExecutionMetaCore,
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
  finalizeRun,
  registerExecution,
  type FinalizeExecutionInput,
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
export { deriveResumability, type ResumabilityDecision } from './resumability';
/** The KV key of a run's checkpoint: hosts `stat` it to answer "is there
 *  something to continue" without parsing the record. */
export { flowKey } from '@agent/node/persistedFlow';
export { formatConversationMessage } from './conversationFormat';
export {
  ExecutionLeaseActiveError,
  ExecutionLeaseLostError,
  executionHeldMessage,
} from './executionLease';
export { persistChildRunResultMeta } from './childRunPersistence';
export { resolveChildRunOutput } from './childRunOutput';
export {
  SessionStores,
  type DeleteAllStreamsResult,
  type DeleteStreamResult,
} from './SessionStores';
