// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import * as path from 'path';
import * as logger from '@logger/logUtils';
import { isValidAgentYaml } from '@agent/runtime/agentLoad';
import { getConfig } from '@utils/config';

const CHANNEL = 'AgentRegister';
logger.initialize(CHANNEL);

/**
 * Prompt the user to add a newly created agent to the `texra.agents` setting.
 * If the agent already exists in the configuration the function silently
 * returns.
 */
export async function promptToAddAgentToConfig(
  agentName: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const current = config.get<string[]>('texra.agents', []);

  const baseName = agentName.endsWith('_multiple')
    ? agentName.replace(/_multiple$/, '')
    : agentName;
  const multipleName = agentName.endsWith('_multiple')
    ? agentName
    : `${agentName}_multiple`;

  // Check if agent already exists (exact match)
  if (current.includes(agentName)) {
    logger.debug(CHANNEL, `Agent "${agentName}" already in configuration`);
    return;
  }

  // Check if the base/multiple counterpart already exists
  if (agentName.endsWith('_multiple')) {
    // Adding a _multiple variant, check if base agent exists
    if (current.includes(baseName)) {
      logger.debug(
        CHANNEL,
        `Base agent "${baseName}" already in configuration, skipping "${agentName}"`,
      );
      return;
    }
  } else {
    // Adding a base agent, check if _multiple variant exists
    if (current.includes(multipleName)) {
      logger.debug(
        CHANNEL,
        `Multiple variant "${multipleName}" already in configuration, skipping "${agentName}"`,
      );
      return;
    }
  }

  const addButton = 'Add Agent';
  const choice = await vscode.window.showInformationMessage(
    `Agent "${agentName}" was created. Add it to 'texra.agents'?`,
    addButton,
    'Cancel',
  );

  if (choice === addButton) {
    current.push(agentName);
    await config.update(
      'texra.agents',
      current,
      vscode.ConfigurationTarget.Workspace,
    );
    vscode.window.showInformationMessage(
      `Added "${agentName}" to texra.agents`,
    );
  }
}

/**
 * Validate the given YAML file as an agent definition and prompt to add
 * the agent name to the configuration if it isn't already present.
 *
 * @param filePath Absolute path to the YAML file
 * @param showInvalid Whether to warn when the YAML is invalid
 */
export async function validateYamlAndPromptAdd(
  filePath: string,
  showInvalid = false,
): Promise<void> {
  const validationResult = await isValidAgentYaml(filePath);
  if (!validationResult) {
    if (showInvalid) {
      vscode.window.showWarningMessage(
        'Selected file is not a valid agent YAML.',
      );
    }
    return;
  }

  const filenameBase = path.basename(filePath, '.yaml');
  const internalName = validationResult.name;

  if (filenameBase !== internalName) {
    vscode.window.showWarningMessage(
      `Agent file '${filenameBase}.yaml' has a different internal name '${internalName}' defined in its YAML. ` +
        `Consider renaming the file or updating the internal name in the YAML for consistency.`,
    );
    return;
  }

  const configuredAgents = getConfig<string[]>('texra.agents', []);
  if (!configuredAgents.includes(filenameBase)) {
    await promptToAddAgentToConfig(filenameBase);
  }
}
