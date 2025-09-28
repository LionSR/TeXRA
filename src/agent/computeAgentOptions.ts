// Third-party imports
import { glob } from 'glob';
import * as vscode from 'vscode';

// Local imports - agent utilities
import {
  buildAgentOptionsPayload,
  type AgentDirectoryMap,
  type AgentOptionsPayload,
} from '@agent/utils/agentOptionMetadata';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { getConfig } from '@utils/config';

export type { AgentOptionsPayload };

/**
 * Get all available agents including tool-use agents if enabled.
 */
export async function getAllAgents(
  context: vscode.ExtensionContext,
): Promise<string[]> {
  const workflowAgents = getConfig<string[]>('agents', []);
  const configuredToolUseAgents = getConfig<string[]>('toolUseAgents', []);
  const includeToolUse = getConfig<boolean>('includeToolUseAgents', false);

  if (!includeToolUse) {
    return Array.from(new Set([...workflowAgents, ...configuredToolUseAgents]));
  }

  const toolUseDir = await agentDirectories.builtInToolUse(context);
  try {
    const toolUseFiles = await glob('**/*.yaml', {
      cwd: toolUseDir,
      dot: false,
      nodir: true,
      absolute: false,
    });
    const discoveredToolUseAgents = toolUseFiles.map((f) =>
      f.replace(/\.yaml$/, '').replace(/.*\//, ''),
    );
    return Array.from(
      new Set([
        ...workflowAgents,
        ...configuredToolUseAgents,
        ...discoveredToolUseAgents,
      ]),
    );
  } catch {
    return Array.from(new Set([...workflowAgents, ...configuredToolUseAgents]));
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

  return buildAgentOptionsPayload(allAgents, dirs);
}
