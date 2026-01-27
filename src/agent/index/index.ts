/**
 * Agent index module - exports from the simplified agent registry.
 */

// AgentSource is defined in @agent/core/AgentDataclass (value + type with same name)
export { AgentSource } from '@agent/core/AgentDataclass';

// AgentOptionData: canonical type from shared schemas (Zod source of truth)
export type { AgentOptionData } from '@shared/schemas';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  type RemoteVisibility,
  type AgentOptionsDataPayload,
  // Core functions
  loadAgents,
  ensureAgentsLoaded,
  isAgentCacheInitialized,
  getAgent,
  updateAgentDescription,
  resolveAgent,
  getWorkflowAgents,
  getToolUseAgents,
  getVisibleWorkflowAgents,
  getVisibleToolUseAgents,
  getAgentsBySource,
  refresh,
  // Typed data options
  buildAgentOptionsData,
  computeAgentOptionsData,
  DEFAULT_WORKFLOW_AGENT,
  DEFAULT_TOOL_USE_AGENT,
  // Key helpers
  createKey,
  parseKey,
  getCleanAgentName,
  // _multiple helpers
  isMultipleVariant,
  getBaseName,
  getMultipleName,
  // Source helpers
  isRemoteAgent,
  shouldShowSourceIndicator,
} from './agentRegistry';
