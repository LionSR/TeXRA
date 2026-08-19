/**
 * Agent index module - public API for the agent registry.
 */

export type { AgentSource } from '@shared/schemas';

export {
  AgentDirectoryService,
  type AgentDirectoryEntry,
} from './AgentDirectoryService';

export {
  AgentRosterController,
  InvalidAgentTeamError,
} from '../roster/AgentRosterController';

export {
  // Types
  type AgentEntry,
} from './agentEntry';

export {
  // Core functions
  loadAgents,
  registerInlineAgents,
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
