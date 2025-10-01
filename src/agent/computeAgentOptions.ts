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
 * Collect configured workflow agents alongside configured and discovered tool-use agents.
 */
export interface AgentNameBuckets {
  allAgents: string[];
  toolUseAgents: string[];
}

export async function getAllAgents(
  context: vscode.ExtensionContext,
): Promise<AgentNameBuckets> {
  const workflowAgents = getConfig<string[]>('agents', []);
  const configuredToolUseAgents = getConfig<string[]>('toolUseAgents', []);

  const toolUseDir = await agentDirectories.builtInToolUse(context);
  let discoveredToolUseAgents: string[] = [];
  try {
    const toolUseFiles = await glob('**/*.yaml', {
      cwd: toolUseDir,
      dot: false,
      nodir: true,
      absolute: false,
    });
    discoveredToolUseAgents = toolUseFiles.map((f) =>
      f.replace(/\.yaml$/, '').replace(/.*\//, ''),
    );
  } catch {
    discoveredToolUseAgents = [];
  }

  const toolUseAgents = Array.from(
    new Set([...configuredToolUseAgents, ...discoveredToolUseAgents]),
  );
  const allAgents = Array.from(new Set([...workflowAgents, ...toolUseAgents]));

  return { allAgents, toolUseAgents };
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
  const { allAgents, toolUseAgents } = await getAllAgents(context);
  const dirs = await getAgentDirectories(context);

  return buildAgentOptionsPayload(allAgents, dirs, toolUseAgents);
}
