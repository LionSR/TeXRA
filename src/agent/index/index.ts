/**
 * Agent index module - public API for the agent registry.
 */

// AgentSource is defined in @agent/core/AgentDataclass (value + type with same name)
export { AgentSource } from '@agent/core/AgentDataclass';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  // Core functions
  loadAgents,
  getAgent,
  resolveAgent,
  getWorkflowAgents,
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
  getVisibleWorkflowAgents,
  getVisibleToolUseAgents,
  // Description update (for remote agent loading)
  updateAgentDescription,
} from './agentRegistry';
