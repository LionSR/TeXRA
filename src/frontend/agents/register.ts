// Utilities for registering newly created agents

// Local imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Internal imports - import directly to avoid circular dependency via barrel export
import { getBaseName, getMultipleName } from '@agent/index/agentRegistry';
import { isValidAgentYaml } from '@agent/runtime/agentLoad';
import {
  AgentCategory,
  type AgentSetting,
  type AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
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

  if (variant.isMultipleOutput) {
    if (
      variant.baseAgentName &&
      configuredAgents.includes(variant.baseAgentName)
    ) {
      return 'baseRegistered';
    }
  } else {
    if (
      variant.multipleAgentName &&
      configuredAgents.includes(variant.multipleAgentName)
    ) {
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

  const settings = validationResult.settings;
  const isWorkflow = settings.agentCategory !== AgentCategory.ToolUse;
  const workflowSettings = isWorkflow
    ? (settings as AgentWorkflowSetting)
    : undefined;
  const defaultOutputs = settings.defaultOutputFiles ?? [];
  const hasMultipleDefaults = defaultOutputs.length > 1;
  const isMultipleOutput = Boolean(
    workflowSettings?.isMultipleOutput ?? (isWorkflow && hasMultipleDefaults),
  );

  const metadata: AgentVariantMetadata = {
    isMultipleOutput,
    baseAgentName: isMultipleOutput ? getBaseName(internalName) : undefined,
    multipleAgentName: isMultipleOutput
      ? undefined
      : getMultipleName(internalName),
  };

  await promptToAddAgentToConfig(filenameBase, !prompt, metadata);
}
