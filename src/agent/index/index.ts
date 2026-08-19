/**
 * Agent index module - public API for the agent registry.
 */

export type { AgentSource } from '@shared/schemas';

/** All built-in delegating team roots (remote-catalog + bundled). */
export { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@shared/constants/agents';

export {
  AgentDirectoryService,
  type AbsoluteDirectoryAccess,
  type AgentDirectoryEntry,
  type AgentDirectoryIssueReporter,
  type AgentDirectoryPathStorage,
  type AgentDirectoryServiceLogger,
} from './AgentDirectoryService';

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
  getCustomAgentScanIssues,
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
