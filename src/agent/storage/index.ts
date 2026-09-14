/**
 * Agent storage — the cross-host public surface of `src/agent/storage`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each storage module by path. This is the curated host
 * boundary for run records, run lifecycle and listing, resumability, and
 * conversation formatting — decoupling host code from the storage internals'
 * file layout, per the module-level barrel pattern set by `@agent/runtime`
 * (#10011).
 */

export { type ChildRecord, getRunRecords } from './runRecords';
export { buildCliWorkflowResultMeta, unwrapResultMeta } from './resultMeta';
export {
  listRunWorkspaceFiles,
  resolveRunWorkspaceFilePath,
} from './runWorkspaceFiles';
export { finalizeRun, registerRun, readRunChildren } from './runLifecycle';
export {
  type AgentRunListingEntry,
  type RunListingEntry,
  createLatexRunDiscovery,
  listRuns,
  isUserVisibleRun,
} from './runListing';
export {
  checkpointExists,
  deriveResumability,
  type ResumabilityDecision,
} from './resumability';
export { formatConversationMessage } from './conversationFormat';
export { resolveChildRunOutput } from './childRunOutput';
