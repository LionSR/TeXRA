/**
 * Agent index module - public API for the agent registry.
 */

export { AgentSource } from '@shared/schemas/agent';

export {
  AgentDirectoryService,
  type AbsoluteDirectoryAccess,
  type AgentDirectoryDocsId,
  type AgentDirectoryIssueReporter,
  type AgentDirectoryPathStorage,
  type AgentDirectoryServiceLogger,
  type AgentDirectoryServiceOptions,
  type CustomAgentDirectoryStore,
} from './AgentDirectoryService';

export { type BundledAgentDirectoryName } from './BundledAgentDirectories';

export {
  GlobalStorageAgentDirectoryStorage,
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

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  // Core functions
  loadAgents,
  getAgent,
  resolveAgent,
  resolveAgentInCategory,
  getAgentsByCategory,
  getAgentsBySource,
  refresh,
  // Typed data options
  computeAgentOptionsData,
  // Key helpers
  createKey,
  resolveAgentKey,
  // Source helpers
  isRemoteAgent,
  // Visible agents (for dropdowns and tools)
  getVisibleAgents,
  // All built-in delegating team roots (relay-served + bundled)
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
} from './agentRegistry';
