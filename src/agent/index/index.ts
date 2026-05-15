/**
 * Agent index module - public API for the agent registry.
 */

export { AgentSource } from '@shared/schemas/agent';

export {
  DEFAULT_CUSTOM_AGENTS_DIR_NAME,
  AgentDirectoryService,
  type AbsoluteDirectoryAccess,
  type AgentDirectoryDocsId,
  type AgentDirectoryIssueReporter,
  type AgentDirectoryPathStorage,
  type AgentDirectoryServiceLogger,
  type AgentDirectoryServiceOptions,
  type CustomAgentDirectoryStore,
} from './AgentDirectoryService';

export {
  BUNDLED_AGENT_DIRECTORY_NAMES,
  type BundledAgentDirectoryName,
} from './BundledAgentDirectories';

export {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
  type AgentDirectoryBundleSource,
  type AgentDirectoryStorage,
  type AgentDirectorySyncLogger,
  type AgentDirectoryVersionStore,
  type BundledAgentDirectorySyncOptions,
} from './AgentDirectorySync';

export {
  type AgentDirectories,
  setAgentDirectories,
} from './agentDirectoriesRegistry';

export { toRemoteAgentProfileData } from './remoteAgentProfileData';

export { buildStreamTabInfo, type StreamTabInfoInputs } from './streamTabInfo';

export { peekWorktreeInfo, resolveWorktreeInfo } from './worktreeInfo';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  // Core functions
  loadAgents,
  getAgent,
  resolveAgent,
  getWorkflowAgents,
  getToolUseAgents,
  getAgentsBySource,
  refresh,
  // Typed data options
  computeAgentOptionsData,
  // Key helpers
  createKey,
  getCleanAgentName,
  resolveAgentKey,
  // Source helpers
  isRemoteAgent,
  // Visible agents (for dropdowns and tools)
  getVisibleAgents,
  // Description update (for remote agent loading)
  updateAgentDescription,
} from './agentRegistry';
