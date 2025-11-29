/**
 * Agent index module - single source of truth for agent metadata.
 */

export { AgentIndex } from './AgentIndex';
export {
  type AgentIndexEntry,
  type AgentIndexKey,
  createAgentIndexKey,
  parseAgentIndexKey,
  isAgentIndexKey,
  getSourceDisplayLabel,
  shouldShowSourceIndicator,
} from './AgentIndexEntry';
export { AgentIndexLoader } from './AgentIndexLoader';
export {
  buildAgentOptionsFromIndex,
  getDefaultWorkflowAgent,
  getDefaultToolUseAgent,
  DEFAULT_WORKFLOW_AGENT,
  DEFAULT_TOOL_USE_AGENT,
  type AgentOptionsPayload,
  type AgentOptionDefaults,
} from './AgentOptionsBuilder';
