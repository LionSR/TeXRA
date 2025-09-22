// Third-party imports
import { glob } from 'glob';
import * as vscode from 'vscode';

// Local imports - agent utilities
import {
  createAgentOptionTag,
  getAgentOptionMetadata,
  type AgentDirectoryMap,
  buildGroupedAgentOptions,
} from '@agent/utils/agentOptionMetadata';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { getConfig } from '@utils/config';

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
    custom: await agentDirectories.custom(),
    builtIn: await agentDirectories.builtIn(context),
    builtInToolUse: await agentDirectories.builtInToolUse(context),
  };
}

/**
 * Compute agent <option> tags for the agent dropdown.
 * Agents missing a YAML definition are marked as disabled and cannot be selected.
 * A codicon indicator is added via data-multiple when a corresponding
 * `_multiple.yaml` file exists.
 */
export async function computeAgentOptions(
  context: vscode.ExtensionContext,
): Promise<string> {
  const allAgents = await getAllAgents(context);
  const dirs = await getAgentDirectories(context);

  if (allAgents.length === 0) {
    return '';
  }

  const grouped = buildGroupedAgentOptions(allAgents, dirs);
  if (grouped) {
    return grouped;
  }

  const optionTags = allAgents.map((agent) => {
    const metadata = getAgentOptionMetadata(agent, dirs);
    return createAgentOptionTag(agent, metadata);
  });

  return optionTags.join('\n');
}
