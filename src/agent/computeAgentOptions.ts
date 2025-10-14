// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import {
  buildAgentOptionsPayload,
  DEFAULT_TOOL_USE_AGENT,
  DEFAULT_WORKFLOW_AGENT,
  type AgentDirectoryMap,
  type AgentOptionsPayload,
  type RemoteAgentOption,
} from '@agent/utils/agentOptionMetadata';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { remoteAgentRegistry } from '@frontend/agents/RemoteAgentRegistry';
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

export async function getAllAgents(
  context: vscode.ExtensionContext,
): Promise<AgentNameBuckets> {
  const configuredWorkflowAgents = getConfig<string[]>('agents', []);
  const configuredToolUseAgents = getConfig<string[]>('toolUseAgents', []);

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
async function getAgentDirectories(
  context: vscode.ExtensionContext,
  remoteAgents: Record<string, RemoteAgentOption>,
): Promise<AgentDirectoryMap> {
  return {
    custom: await agentDirectories.custom(context),
    builtIn: await agentDirectories.builtIn(context),
    builtInToolUse: await agentDirectories.builtInToolUse(context),
    remote: remoteAgents,
  };
}

/**
 * Compute agent <option> tags for the agent dropdown.
 * Agents missing a YAML definition are marked as disabled and cannot be selected.
 * A codicon indicator is added via data-multiple when either the agent declares
 * `isMultipleOutput: true` or a sibling `_multiple.yaml` definition exists.
 */
export async function computeAgentOptions(
  context: vscode.ExtensionContext,
): Promise<AgentOptionsPayload> {
  const remoteAgents = remoteAgentRegistry.list();
  const remoteOptions: Record<string, RemoteAgentOption> = {};
  for (const agent of remoteAgents) {
    remoteOptions[agent.name] = {
      displayName: agent.displayName || agent.name,
      isToolUse: agent.isToolUse,
      isMultipleOutput: agent.isMultipleOutput,
    };
  }

  const { allAgents, toolUseAgents, defaultWorkflowAgent } =
    await getAllAgents(context);

  const combinedAgents = Array.from(
    new Set([...allAgents, ...remoteAgents.map((agent) => agent.name)]),
  );
  const combinedToolUseAgents = Array.from(
    new Set([
      ...toolUseAgents,
      ...remoteAgents
        .filter((agent) => agent.isToolUse)
        .map((agent) => agent.name),
    ]),
  );

  const dirs = await getAgentDirectories(context, remoteOptions);

  return buildAgentOptionsPayload(combinedAgents, dirs, combinedToolUseAgents, {
    workflowAgent: defaultWorkflowAgent,
    toolUseAgent: DEFAULT_TOOL_USE_AGENT,
  });
}
