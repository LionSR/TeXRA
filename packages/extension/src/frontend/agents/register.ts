// Utilities for registering newly created agents

// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentCategory } from '@agent/core';
import { isValidAgentYaml } from '@agent/runtime/agentLoad';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import * as logger from '@logger/logUtils';

const CHANNEL = 'AgentRegister';
logger.initialize(CHANNEL);

export type AgentRegistrationSkipReason = 'alreadyRegistered';

export function getAgentRegistrationSkipReason(
  agentName: string,
  configuredAgents: string[],
): AgentRegistrationSkipReason | undefined {
  if (configuredAgents.includes(agentName)) {
    return 'alreadyRegistered';
  }
  return undefined;
}

export async function promptToAddAgentToConfig(
  agentName: string,
  autoAdd = false,
  category: 'workflow' | 'toolUse' = 'workflow',
): Promise<void> {
  const stateKey =
    category === 'toolUse'
      ? WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS
      : WorkspaceStateKey.ENABLED_AGENTS;
  const current = workspaceSM.get<string[]>(stateKey, []);

  const skipReason = getAgentRegistrationSkipReason(agentName, current);
  if (skipReason) {
    logger.debug(CHANNEL, `Agent "${agentName}" already in configuration`);
    return;
  }

  const shouldAdd =
    autoAdd ||
    (await vscode.window.showInformationMessage(
      `Agent "${agentName}" was created or modified. Show it in the agent dropdown?`,
      'Add Agent',
      'Cancel',
    )) === 'Add Agent';

  if (shouldAdd) {
    current.push(agentName);
    await workspaceSM.update(stateKey, current);
    await vscode.commands.executeCommand('texra.refreshAllOptions');
    vscode.window.showInformationMessage(`Agent "${agentName}" is now visible`);
  }
}

/**
 * Validate the given YAML file as an agent definition and prompt to add
 * the agent name to the configuration if it isn't already present.
 *
 * @param filePath Absolute path to the YAML file
 * @param showInvalid Whether to warn when the YAML is invalid
 * @param prompt Whether to prompt the user (false = auto-add)
 */
export async function validateYamlAndPromptAdd(
  filePath: string,
  showInvalid = false,
  prompt = true,
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

  const filenameBase = path.basename(filePath, path.extname(filePath));
  const internalName = validationResult.name;

  if (filenameBase !== internalName) {
    vscode.window.showWarningMessage(
      `Agent file '${filenameBase}.yaml' has a different internal name '${internalName}' defined in its YAML. ` +
        `Consider renaming the file or updating the internal name in the YAML for consistency.`,
    );
    return;
  }

  const configuredAgents = workspaceSM.get<string[]>(
    WorkspaceStateKey.ENABLED_AGENTS,
    [],
  );
  if (configuredAgents.includes(filenameBase)) {
    return;
  }

  const { settings } = validationResult;
  const isWorkflow = settings.agentCategory !== AgentCategory.ToolUse;
  const category = isWorkflow ? 'workflow' : 'toolUse';

  await promptToAddAgentToConfig(filenameBase, !prompt, category);
}
