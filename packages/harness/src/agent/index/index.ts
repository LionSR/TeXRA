/**
 * Public door onto the agent registry and agent list — the agent-catalog
 * loading, resolution, and directory-scanning surface hosts reach instead of
 * deep-reaching `./agentRegistry`, `./AgentDirectoryService`, or
 * `../workspaceAgents/WorkspaceAgentsController` by path. Following the same pattern as
 * `@agent/runtime` (#10011) and `@agent/storage`, this decouples host code
 * from the registry's internal file layout, and the harness deep-import
 * ratchet (`config/ratchets/harness-deep-import-baseline.json`) collapses each
 * host's `@agent/index` specifier to this single door.
 */

export {
  AgentDirectoryService,
  agentSourceRoots,
} from './AgentDirectoryService';

export {
  customCopyPath,
  keepCustomAgent,
  writeStampedCopy,
} from './customAgentCopy';

export { BUNDLED_AGENTS_DIRECTORY } from './BundledAgentDirectories';

export { InvalidAgentTeamError } from '../workspaceAgents/WorkspaceAgentsController';

export type { AgentEntry } from './agentEntry';

export {
  changedBuiltInOf,
  getAgent,
  getCatalogAgent,
  resolveAgentForLaunch,
  getCatalogAgents,
  getCatalogLoadFailure,
  getCustomAgentScanIssues,
  refresh,
  settledCatalog,
  // Typed data options
  computeAgentOptionsData,
  // Visible agents (for dropdowns and tools)
  getVisibleAgents,
  createWorkspaceAgentsController,
} from './agentRegistry';

export type { WorkspaceAgentsStores } from './agentRegistry';
