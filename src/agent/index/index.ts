/**
 * Agent index module - exports from the simplified agent registry.
 *
 * For internal helpers (getVisibleWorkflowAgents, updateAgentDescription, etc.),
 * import directly from @agent/index/agentRegistry.
 */

// AgentSource is defined in @agent/core/AgentDataclass (value + type with same name)
export { AgentSource } from '@agent/core/AgentDataclass';

export {
  // Types
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
  // _multiple helpers
  getBaseName,
  getMultipleName,
  // Source helpers
  isRemoteAgent,
} from './agentRegistry';
