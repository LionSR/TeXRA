/**
 * Agent index module - exports from the simplified agent registry.
 */

export {
  // Types
  type AgentEntry,
  type AgentSource,
  type ResolvedAgent,
  type RemoteVisibility,
  type AgentOptionsPayload,
  // Core functions
  loadAgents,
  getAgent,
  resolveAgent,
  getWorkflowAgents,
  getToolUseAgents,
  getAgentsBySource,
  isLoaded,
  waitForLoad,
  refresh,
  // HTML options
  buildAgentOptions,
  computeAgentOptions,
  computeAgentOptionsSync,
  refreshAgentOptions,
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
