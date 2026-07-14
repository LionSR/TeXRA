/**
 * Agent index module - public API for the agent registry.
 */

export { AgentSource } from '@shared/schemas/agent';

export {
  AgentDirectoryService,
  type AbsoluteDirectoryAccess,
  type AgentDirectoryEntry,
  type AgentDirectoryIssueReporter,
  type AgentDirectoryPathStorage,
  type AgentDirectoryServiceLogger,
} from './AgentDirectoryService';

export { GlobalStorageAgentDirectoryStorage } from './AgentDirectorySync';

export { toRemoteAgentProfileData } from './remoteAgentProfileData';

export {
  AgentRosterController,
  type AgentRosterControllerDeps,
  type AgentRosterSnapshot,
} from '../roster/AgentRosterController';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  // Core functions
  loadAgents,
  getAgent,
  resolveAgent,
  resolveAgentForLaunch,
  getAgentsByCategory,
  getAgentsBySource,
  refresh,
  invalidateRemoteAgentsAfterSignOut,
  // Typed data options
  computeAgentOptionsData,
  // Key helpers
  createKey,
  resolveAgentKey,
  getRosterAgent,
  // Source helpers
  isRemoteAgent,
  // Visible agents (for dropdowns and tools)
  getVisibleAgents,
  // Canonical name-or-key identity matcher (shared by out-of-registry callers)
  findAgentByIdentifier,
  // All built-in delegating team roots (relay-served + bundled)
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
} from './agentRegistry';
