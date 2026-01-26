/**
 * Agent index module - exports from the simplified agent registry.
 */

// AgentSource is defined in @agent/core/AgentDataclass (value + type with same name)
export { AgentSource } from '@agent/core/AgentDataclass';

export {
  // Types
  type AgentEntry,
  type ResolvedAgent,
  type RemoteVisibility,
  type AgentOptionsPayload,
  type AgentOptionData,
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
  // HTML options (legacy)
  buildAgentOptions,
  computeAgentOptions,
  computeAgentOptionsSync,
  // Typed data options (new)
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
