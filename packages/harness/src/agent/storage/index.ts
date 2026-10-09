/**
 * Agent storage — the cross-host public surface of `packages/harness/src/agent/storage`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching each storage module by path. This is the curated host
 * boundary for run records, run lifecycle and listing, resumability, and
 * conversation formatting — decoupling host code from the storage internals'
 * file layout, per the module-level barrel pattern set by `@agent/runtime`
 * (#10011).
 */

export { getRunRecords } from './runRecords';
export type { RunResult } from './resultMeta';
export {
  listRunWorkspaceFiles,
  resolveRunWorkspaceFilePath,
} from './runWorkspaceFiles';
export { registerRun } from './runLifecycle';
export {
  type AgentRunListingEntry,
  listRuns,
  isUserVisibleRun,
} from './runListing';
export { deriveResumability, type ResumabilityDecision } from './resumability';
export { formatConversationMessage } from './conversationFormat';
