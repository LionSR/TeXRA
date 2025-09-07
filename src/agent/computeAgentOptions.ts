// Third-party imports
import { glob } from 'glob';
import * as vscode from 'vscode';

// Local imports - agent utilities
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { getConfig } from '@utils/config';

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
 * Compute agent <option> tags for the agent dropdown.
 * Agents missing a YAML definition are marked as disabled and cannot be selected.
 * A codicon indicator is added via data-multiple when a corresponding
 * `_multiple.yaml` file exists.
 */
export async function computeAgentOptions(
  context: vscode.ExtensionContext,
): Promise<string> {
  const agents = getConfig<string[]>('agents', []);

  const customDir = await agentDirectories.custom();
  const builtInDir = await agentDirectories.builtIn(context);
  const builtInToolUseDir = await agentDirectories.builtInToolUse(context);

  const optionTags = await Promise.all(
    agents.map(async (agent) => {
      const yamlExists =
        (await fileExists(customDir, `**/${agent}.yaml`)) ||
        (await fileExists(builtInDir, `**/${agent}.yaml`)) ||
        (await fileExists(builtInToolUseDir, `**/${agent}.yaml`));

      const multipleExists =
        (await fileExists(customDir, `**/${agent}_multiple.yaml`)) ||
        (await fileExists(builtInDir, `**/${agent}_multiple.yaml`)) ||
        (await fileExists(builtInToolUseDir, `**/${agent}_multiple.yaml`));

      const disabledAttr = yamlExists ? '' : ' class="disabled-option disabled-agent"';
      const multipleAttr = multipleExists ? ' data-multiple="true"' : '';

      return `<option value="${agent}"${disabledAttr}${multipleAttr}>${agent}</option>`;
    }),
  );

  return optionTags.join('\n');
}
