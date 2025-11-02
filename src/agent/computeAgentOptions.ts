// Local imports - agent utilities
import {
  buildAgentOptionsPayload,
  DEFAULT_TOOL_USE_AGENT,
  DEFAULT_WORKFLOW_AGENT,
  type AgentDirectoryMap,
  type AgentOptionsPayload,
} from '@agent/utils/agentOptionMetadata';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { getConfig } from '@utils/config';

export type { AgentOptionsPayload };

/**
 * Collect configured workflow agents alongside configured tool-use agents and defaults.
 */
export interface AgentNameBuckets {
  allAgents: string[];
  toolUseAgents: string[];
  defaultWorkflowAgent: string;
}

export async function getAllAgents(): Promise<AgentNameBuckets> {
  const configuredWorkflowAgents = getConfig<string[]>(
    'texra.agents',
    [],
  );
  const configuredToolUseAgents = getConfig<string[]>(
    'texra.toolUseAgents',
    [],
  );

  const hasConfiguredWorkflowAgents = configuredWorkflowAgents.length > 0;
  const workflowAgents = hasConfiguredWorkflowAgents
    ? Array.from(new Set(configuredWorkflowAgents))
    : [DEFAULT_WORKFLOW_AGENT];
  const toolUseAgents = Array.from(
    new Set([DEFAULT_TOOL_USE_AGENT, ...configuredToolUseAgents]),
  );
  const allAgents = Array.from(new Set([...workflowAgents, ...toolUseAgents]));

  const defaultWorkflowAgent = configuredWorkflowAgents.includes(
    DEFAULT_WORKFLOW_AGENT,
  )
    ? DEFAULT_WORKFLOW_AGENT
    : (workflowAgents[0] ?? DEFAULT_WORKFLOW_AGENT);

  return { allAgents, toolUseAgents, defaultWorkflowAgent };
}

/**
 * Get all agent directories.
 */
async function getAgentDirectories(): Promise<AgentDirectoryMap> {
  return {
    custom: await agentDirectories.custom(),
    builtIn: await agentDirectories.builtIn(),
    builtInToolUse: await agentDirectories.builtInToolUse(),
  };
}

/**
 * Compute agent <vscode-option> tags for the agent dropdown.
 * Agents missing a YAML definition are marked as disabled and cannot be selected.
 * A codicon indicator is added via data-multiple when either the agent declares
 * `isMultipleOutput: true` or a sibling `_multiple.yaml` definition exists.
 */
export async function computeAgentOptions(): Promise<AgentOptionsPayload> {
  const { allAgents, toolUseAgents, defaultWorkflowAgent } =
    await getAllAgents();
  const dirs = await getAgentDirectories();

  return buildAgentOptionsPayload(allAgents, dirs, toolUseAgents, {
    workflowAgent: defaultWorkflowAgent,
    toolUseAgent: DEFAULT_TOOL_USE_AGENT,
  });
}
