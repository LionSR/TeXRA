/**
 * Agent index module - single source of truth for agent metadata.
 */

export { AgentIndex } from './AgentIndex';
export {
  type AgentIndexEntry,
  type AgentIndexKey,
  type RemoteAgentVisibility,
  createAgentIndexKey,
  parseAgentIndexKey,
  isRemoteAgent,
  shouldShowSourceIndicator,
} from './AgentIndexEntry';
export { AgentIndexLoader } from './AgentIndexLoader';
export {
  buildAgentOptionsFromIndex,
  getDefaultWorkflowAgent,
  getDefaultToolUseAgent,
  computeAgentOptions,
  computeAgentOptionsSync,
  refreshAgentOptions,
  DEFAULT_WORKFLOW_AGENT,
  DEFAULT_TOOL_USE_AGENT,
  type AgentOptionsPayload,
  type AgentOptionDefaults,
} from './AgentOptionsBuilder';
