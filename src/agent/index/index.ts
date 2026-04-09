/**
 * Agent index module - public API for the agent registry.
 */

// AgentSource: canonical definition in @shared/schemas/agent, re-exported via AgentDataclass
export { AgentSource } from '@agent/core/AgentDataclass';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  type AgentDirectories,
  // Core functions
  loadAgents,
  setAgentDirectories,
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
  // _multiple helpers
  getBaseName,
  getMultipleName,
  // Source helpers
  isRemoteAgent,
  // Visible agents (for dropdowns and tools)
  getVisibleAgents,
  // Deduplication
  deduplicateByName,
  // Description update (for remote agent loading)
  updateAgentDescription,
} from './agentRegistry';
