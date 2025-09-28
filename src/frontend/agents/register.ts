// Utilities for registering newly created agents

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import * as path from 'path';
import * as logger from '@logger/logUtils';
import { isValidAgentYaml } from '@agent/runtime/agentLoad';
import type { AgentSetting } from '@agent/core/AgentDataclass';
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

  if (variant.isMultipleOutput) {
    const baseName = variant.baseAgentName;
    if (baseName && configuredAgents.includes(baseName)) {
      return 'baseRegistered';
    }
  } else {
    const siblingMultiple = variant.multipleAgentName;
    if (siblingMultiple && configuredAgents.includes(siblingMultiple)) {
      return 'multipleRegistered';
    }
  }

  return undefined;
}

export async function promptToAddAgentToConfig(
  agentName: string,
  autoAdd = false,
  variant: AgentVariantMetadata = {},
): Promise<void> {
  const current = getConfig<string[]>('agents', []);

  const skipReason = getAgentRegistrationSkipReason(agentName, current, variant);
  if (skipReason === 'alreadyRegistered') {
    logger.debug(CHANNEL, `Agent "${agentName}" already in configuration`);
    return;
  }
  if (skipReason === 'baseRegistered' && variant.baseAgentName) {
    logger.debug(
      CHANNEL,
      `Base agent "${variant.baseAgentName}" already in configuration, skipping "${agentName}"`,
    );
    return;
  }
  if (skipReason === 'multipleRegistered' && variant.multipleAgentName) {
    logger.debug(
      CHANNEL,
      `Multiple variant "${variant.multipleAgentName}" already in configuration, skipping "${agentName}"`,
    );
    return;
  }

  if (autoAdd) {
    current.push(agentName);
    await updateConfig('agents', current);
    vscode.window.showInformationMessage(
      `Added "${agentName}" to texra.agents`,
    );
    return;
  }

  const addButton = 'Add Agent';
  const choice = await vscode.window.showInformationMessage(
    `Agent "${agentName}" was created or modified. Add it to 'texra.agents'?`,
    addButton,
    'Cancel',
  );

  if (choice === addButton) {
    current.push(agentName);
    await updateConfig('agents', current);
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

  const configuredAgents = getConfig<string[]>('agents', []);
  if (!configuredAgents.includes(filenameBase)) {
    const settings = validationResult.settings as AgentSetting | undefined;
    const defaultOutputs: string[] = settings?.defaultOutputFiles ?? [];
    const hasMultipleDefaults = defaultOutputs.length > 1;
    const declaredMultiple = settings?.isMultipleOutput;
    const legacyMultiple = settings?.useMultipleOutputs;
    const fallbackMultiple =
      legacyMultiple ?? (hasMultipleDefaults ? true : undefined);
    const isMultipleOutput = Boolean(
      (declaredMultiple ?? fallbackMultiple) ?? false,
    );
    const metadata: AgentVariantMetadata = {
      isMultipleOutput,
    };

    if (isMultipleOutput) {
      metadata.baseAgentName = internalName.includes('_multiple')
        ? internalName.replace(/_multiple$/, '')
        : undefined;
    } else {
      metadata.multipleAgentName = `${internalName}_multiple`;
    }

    await promptToAddAgentToConfig(filenameBase, !prompt, metadata);
  }
}
