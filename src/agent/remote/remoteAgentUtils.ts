import * as vscode from 'vscode';

import { createKey, getAgent, type AgentSource } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { delay } from '@utils/core';

const CHANNEL = 'RemoteAgentUtils';
logger.initialize(CHANNEL);

interface SelectAgentResult {
  success: boolean;
  message: string;
  fallbackAction?: 'clipboard' | 'manual';
}

interface SelectAgentOptions {
  showSuccessMessage?: boolean;
  copyToClipboardOnFailure?: boolean;
  source?: AgentSource;
}

/** Select an agent in the main webview's dropdown. */
export async function selectAgentInMainView(
  agentName: string,
  options: SelectAgentOptions = {},
): Promise<SelectAgentResult> {
  const {
    showSuccessMessage = true,
    copyToClipboardOnFailure = false,
    source = 'remote',
  } = options;

  const agentValue = createKey(source as AgentSource, agentName);

  // Focus main view first - triggers initialization if needed
  await vscode.commands.executeCommand('texra.mainView.focus');

  // Brief delay to ensure webview handlers are ready
  await delay(100);

  try {
    const webviewView = await getMainWebview(CHANNEL);

    if (!webviewView) {
      logger.warn(CHANNEL, 'Main webview not available for agent selection');
      return handleFallback(
        agentName,
        'Main webview not available',
        copyToClipboardOnFailure,
      );
    }

    const entry = getAgent(agentValue);
    const sessionType =
      entry?.category === AgentCategory.ToolUse ? 'toolUse' : 'workflow';

    logger.info(
      CHANNEL,
      `Selecting agent "${agentName}" (${agentValue}) in ${sessionType} dropdown`,
    );

    webviewView.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT,
      agentId: agentValue, // Must match schema field name
      sessionType,
    });

    if (showSuccessMessage) {
      void vscode.window.showInformationMessage(
        `Agent "${agentName}" is now selected in the main view.`,
      );
    }

    return {
      success: true,
      message: `Agent "${agentName}" selected successfully`,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error(CHANNEL, `Failed to select agent: ${errorMessage}`);
    return handleFallback(
      agentName,
      `Error: ${errorMessage}`,
      copyToClipboardOnFailure,
    );
  }
}

/** Handle fallback when agent selection fails. */
async function handleFallback(
  agentName: string,
  errorMessage: string,
  copyToClipboard: boolean,
): Promise<SelectAgentResult> {
  if (copyToClipboard) {
    await vscode.env.clipboard.writeText(agentName);
    void vscode.window.showInformationMessage(
      `Could not auto-select agent. Agent name "${agentName}" copied to clipboard - paste it in the agent selector.`,
    );
    return {
      success: false,
      message: `${errorMessage}, copied to clipboard`,
      fallbackAction: 'clipboard',
    };
  }

  void vscode.window.showWarningMessage(
    `Could not auto-select agent. Please manually select "${agentName}" in the agent dropdown.`,
  );
  return {
    success: false,
    message: errorMessage,
    fallbackAction: 'manual',
  };
}
