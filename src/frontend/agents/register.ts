// Utilities for registering newly created agents

// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentCategory, type AgentWorkflowSetting } from '@agent/core';
import { getBaseName, getMultipleName } from '@agent/index';
import { isValidAgentYaml } from '@agent/runtime/agentLoad';
import * as logger from '@logger/logUtils';
import { getConfig, updateConfig } from '@utils/config';

const CHANNEL = 'AgentRegister';
logger.initialize(CHANNEL);

/**
 * Prompt to add a newly created agent to the `texra.agents` setting. When
 * `autoAdd` is true, the agent is added without prompting.
 */
export interface AgentVariantMetadata {
  isMultipleOutput?: boolean;
  baseAgentName?: string;
  multipleAgentName?: string;
}

export type AgentRegistrationSkipReason =
  | 'alreadyRegistered'
  | 'baseRegistered'
  | 'multipleRegistered';

export function getAgentRegistrationSkipReason(
  agentName: string,
  configuredAgents: string[],
  variant: AgentVariantMetadata = {},
): AgentRegistrationSkipReason | undefined {
  if (configuredAgents.includes(agentName)) {
    return 'alreadyRegistered';
  }

  const relatedAgent = variant.isMultipleOutput
    ? variant.baseAgentName
    : variant.multipleAgentName;

  if (relatedAgent && configuredAgents.includes(relatedAgent)) {
    return variant.isMultipleOutput ? 'baseRegistered' : 'multipleRegistered';
  }

  return undefined;
}

export async function promptToAddAgentToConfig(
  agentName: string,
  autoAdd = false,
  variant: AgentVariantMetadata = {},
): Promise<void> {
  const current = getConfig<string[]>('texra.agents', []);

  const skipReason = getAgentRegistrationSkipReason(
    agentName,
    current,
    variant,
  );
  if (skipReason) {
    const messages: Record<AgentRegistrationSkipReason, string> = {
      alreadyRegistered: `Agent "${agentName}" already in configuration`,
      baseRegistered: `Base agent "${variant.baseAgentName}" already in configuration, skipping "${agentName}"`,
      multipleRegistered: `Multiple variant "${variant.multipleAgentName}" already in configuration, skipping "${agentName}"`,
    };
    logger.debug(CHANNEL, messages[skipReason]);
    return;
  }

  const shouldAdd =
    autoAdd ||
    (await vscode.window.showInformationMessage(
      `Agent "${agentName}" was created or modified. Add it to 'texra.agents'?`,
      'Add Agent',
      'Cancel',
    )) === 'Add Agent';

  if (shouldAdd) {
    current.push(agentName);
    await updateConfig('texra.agents', current, { prefix: false });
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

  const configuredAgents = getConfig<string[]>('texra.agents', []);
  if (configuredAgents.includes(filenameBase)) {
    return;
  }

  const { settings } = validationResult;
  const isWorkflow = settings.agentCategory !== AgentCategory.ToolUse;
  const workflowSettings = isWorkflow
    ? (settings as AgentWorkflowSetting)
    : undefined;
  const hasMultipleDefaults = (settings.defaultOutputFiles ?? []).length > 1;
  const isMultipleOutput =
    workflowSettings?.isMultipleOutput ?? (isWorkflow && hasMultipleDefaults);

  const metadata: AgentVariantMetadata = {
    isMultipleOutput,
    baseAgentName: isMultipleOutput ? getBaseName(internalName) : undefined,
    multipleAgentName: isMultipleOutput
      ? undefined
      : getMultipleName(internalName),
  };

  await promptToAddAgentToConfig(filenameBase, !prompt, metadata);
}
