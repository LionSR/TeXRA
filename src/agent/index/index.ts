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

export { toRemoteAgentProfileData } from './remoteAgentProfileData';

export {
  AgentRosterController,
  InvalidAgentTeamError,
} from '../roster/AgentRosterController';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
} from './agentEntry';

export {
  // Core functions
  loadAgents,
  registerInlineAgents,
  clearInlineAgents,
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
  resolveAgentKey,
  getRosterAgent,
  // Source helpers
  isRemoteAgent,
  // Visible agents (for dropdowns and tools)
  getVisibleAgents,
  createWorkspaceAgentRosterController,
} from './agentRegistry';
