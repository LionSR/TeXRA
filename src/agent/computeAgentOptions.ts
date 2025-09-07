// Third-party imports
import { glob } from 'glob';
import * as vscode from 'vscode';

// Local imports - agent utilities
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
 * Check if a YAML file exists for the given agent name under the provided directory.
 */
async function fileExists(dir: string, pattern: string): Promise<boolean> {
  if (!dir) {
    return false;
  }
  const matches = await glob(pattern, {
    cwd: dir,
    dot: false,
    nodir: true,
    absolute: false,
  });
  return matches.length > 0;
}

/**
 * Get all agent directories.
 */
async function getAgentDirectories(context: vscode.ExtensionContext) {
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

  const optionTags = await Promise.all(
    allAgents.map(async (agent) => {
      const yamlExists =
        (await fileExists(dirs.custom, `**/${agent}.yaml`)) ||
        (await fileExists(dirs.builtIn, `**/${agent}.yaml`)) ||
        (await fileExists(dirs.builtInToolUse, `**/${agent}.yaml`));

      const multipleExists =
        (await fileExists(dirs.custom, `**/${agent}_multiple.yaml`)) ||
        (await fileExists(dirs.builtIn, `**/${agent}_multiple.yaml`)) ||
        (await fileExists(dirs.builtInToolUse, `**/${agent}_multiple.yaml`));

      const disabledAttr = yamlExists
        ? ''
        : ' class="disabled-option disabled-agent"';
      const multipleAttr = multipleExists ? ' data-multiple="true"' : '';

      return `<option value="${agent}"${disabledAttr}${multipleAttr}>${agent}</option>`;
    }),
  );

  return optionTags.join('\n');
}
