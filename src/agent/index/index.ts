/**
 * Public door onto the agent registry and roster — the agent-catalog
 * loading, resolution, and directory-scanning surface hosts reach instead of
 * deep-reaching `./agentRegistry`, `./AgentDirectoryService`, or
 * `../roster/AgentRosterController` by path. Following the same pattern as
 * `@agent/runtime` (#10011) and `@agent/storage`, this decouples host code
 * from the registry's internal file layout, and the R-b deep-import width
 * ratchet (`config/ratchets/host-agent-import-baseline.json`) collapses each
 * host's `@agent/index` specifier to this single door.
 */

export type { AgentSource } from '@shared/schemas';

export {
  AgentDirectoryService,
  type AgentDirectoryEntry,
} from './AgentDirectoryService';

export { createPlatformAgentDirectories } from './platformAgentDirectories';
export { BUNDLED_AGENT_DIRECTORY_NAMES } from './BundledAgentDirectories';

export {
  AgentRosterController,
  InvalidAgentTeamError,
} from '../roster/AgentRosterController';

export type { AgentEntry } from './agentEntry';

export {
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
