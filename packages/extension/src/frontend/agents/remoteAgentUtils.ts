import * as vscode from 'vscode';

import { MainViewAgentSelectionController } from '@controllers/mainView/MainViewAgentSelectionController';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas/agent';
import { delay } from '@utils/core';

const CHANNEL = 'RemoteAgentUtils';
logger.initialize(CHANNEL);
const agentSelectionController = new MainViewAgentSelectionController();

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

  // Focus main view first - triggers initialization if needed
  await vscode.commands.executeCommand('texra.showMainView');

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

    const selection = agentSelectionController.getSourceAgentSelection({
      source,
      name: agentName,
    });

    logger.info(
      CHANNEL,
      `Selecting agent "${agentName}" (${selection.agentId}) ` +
        `in ${selection.sessionType} dropdown`,
    );

    webviewView.webview.postMessage(selection);

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
