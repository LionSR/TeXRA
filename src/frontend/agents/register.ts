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

export async function promptToAddAgentToConfig(
  agentName: string,
  autoAdd = false,
  variant: AgentVariantMetadata = {},
): Promise<void> {
  const current = getConfig<string[]>('agents', []);

  const {
    isMultipleOutput = false,
    baseAgentName,
    multipleAgentName,
  } = variant;

  // Check if agent already exists (exact match)
  if (current.includes(agentName)) {
    logger.debug(CHANNEL, `Agent "${agentName}" already in configuration`);
    return;
  }

  // Check if the base/multiple counterpart already exists
  if (isMultipleOutput) {
    const baseName = baseAgentName;
    if (baseName && current.includes(baseName)) {
      logger.debug(
        CHANNEL,
        `Base agent "${baseName}" already in configuration, skipping "${agentName}"`,
      );
      return;
    }
  } else {
    const siblingMultiple = multipleAgentName;
    if (siblingMultiple && current.includes(siblingMultiple)) {
      logger.debug(
        CHANNEL,
        `Multiple variant "${siblingMultiple}" already in configuration, skipping "${agentName}"`,
      );
      return;
    }
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
    const useMultipleOutputs =
      settings?.useMultipleOutputs ?? hasMultipleDefaults;
    const isMultipleOutput = Boolean(useMultipleOutputs);
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
