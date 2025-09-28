// Third-party imports
import { glob } from 'glob';
import * as vscode from 'vscode';

// Local imports - agent utilities
import {
  createAgentOptionTag,
  getAgentOptionMetadata,
  type AgentDirectoryMap,
} from '@agent/utils/agentOptionMetadata';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { getConfig } from '@utils/config';

export interface AgentOptionsPayload {
  workflow: string;
  toolUse: string;
}

/**
 * Get all available agents including tool-use agents if enabled.
 */
export async function getAllAgents(
  context: vscode.ExtensionContext,
): Promise<string[]> {
  const agents = getConfig<string[]>('agents', []);
  const includeToolUse = getConfig<boolean>('includeToolUseAgents', false);

  if (!includeToolUse) {
    return agents;
  }

  // Get tool-use agents
  const toolUseDir = await agentDirectories.builtInToolUse(context);
  try {
    const toolUseFiles = await glob('**/*.yaml', {
      cwd: toolUseDir,
      dot: false,
      nodir: true,
      absolute: false,
    });
    const toolUseAgents = toolUseFiles.map((f) =>
      f.replace(/\.yaml$/, '').replace(/.*\//, ''),
    );
    return Array.from(new Set([...agents, ...toolUseAgents]));
  } catch {
    // If tool-use directory doesn't exist or can't be read, just use base agents
    return agents;
  }
}

/**
 * Get all agent directories.
 */
async function getAgentDirectories(
  context: vscode.ExtensionContext,
): Promise<AgentDirectoryMap> {
  return {
    custom: await agentDirectories.custom(context),
    builtIn: await agentDirectories.builtIn(context),
    builtInToolUse: await agentDirectories.builtInToolUse(context),
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
  const allAgents = await getAllAgents(context);
  const dirs = await getAgentDirectories(context);

  const optionBuckets: AgentOptionsPayload = { workflow: '', toolUse: '' };
  const workflowOptions: string[] = [];
  const toolUseOptions: string[] = [];

  allAgents.forEach((agent) => {
    const metadata = getAgentOptionMetadata(agent, dirs);
    const optionTag = createAgentOptionTag(agent, metadata);
    if (metadata.isToolUse) {
      toolUseOptions.push(optionTag);
    } else {
      workflowOptions.push(optionTag);
    }
  });

  optionBuckets.workflow = workflowOptions.join('\n');
  optionBuckets.toolUse = toolUseOptions.join('\n');

  return optionBuckets;
}
