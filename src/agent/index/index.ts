/**
 * Agent index module - public API for the agent registry.
 */

export type { AgentSource } from '@shared/schemas/agent';

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
  InvalidAgentTeamError,
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
  createWorkspaceAgentRosterController,
  // All built-in delegating team roots (relay-served + bundled)
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
} from './agentRegistry';
