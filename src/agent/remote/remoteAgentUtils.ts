// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { createKey, type AgentSource } from '@agent/index';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';

// Local imports - common
import { MAIN_VIEW_COMMANDS } from '@common/webview';

// Local imports - logger
import * as logger from '@logger/logUtils';

const CHANNEL = 'RemoteAgentUtils';
logger.initialize(CHANNEL);

/**
 * Result of selecting an agent in the main view.
 */
export interface SelectAgentResult {
  success: boolean;
  message: string;
  fallbackAction?: 'clipboard' | 'manual';
}

/**
 * Handle fallback when agent selection fails.
 * Extracted to avoid duplication between error cases.
 */
async function handleSelectionFallback(
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
      message: errorMessage
        ? `${errorMessage}, copied to clipboard`
        : 'Copied to clipboard',
      fallbackAction: 'clipboard',
    };
  } else {
    void vscode.window.showWarningMessage(
      `Could not auto-select agent. Please manually select "${agentName}" in the agent dropdown.`,
    );
    return {
      success: false,
      message: errorMessage || 'Selection failed',
      fallbackAction: 'manual',
    };
  }
}

/**
 * Select an agent in the main webview's dropdown.
 * This is the single source of truth for agent selection across the extension.
 *
 * @param agentName - The name of the agent to select
 * @param options - Optional configuration for the selection behavior
 * @returns Result indicating success/failure and any fallback actions taken
 */
export async function selectAgentInMainView(
  agentName: string,
  options: {
    showSuccessMessage?: boolean;
    copyToClipboardOnFailure?: boolean;
    source?: AgentDirectorySource;
  } = {},
): Promise<SelectAgentResult> {
  const {
    showSuccessMessage = true,
    copyToClipboardOnFailure = false,
    source = AgentDirectorySource.Remote,
  } = options;

  // Format agent value as source:name for dropdown selection
  const agentValue = createKey(source as AgentSource, agentName);

  // Focus the main view first
  await vscode.commands.executeCommand('texra.mainView.focus');

  try {
    const webviewView = await vscode.commands.executeCommand<
      vscode.WebviewView | undefined
    >('texra.getWebviewView');

    if (webviewView) {
      // Send STATE_RESTORE message to set the agent selector value
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.STATE_RESTORE,
        state: {
          workflowAgent: agentValue,
        },
      });

      if (showSuccessMessage) {
        void vscode.window.showInformationMessage(
          `Agent "${agentName}" is now selected.`,
        );
      }

      return {
        success: true,
        message: `Agent "${agentName}" selected successfully`,
      };
    } else {
      logger.warn(CHANNEL, 'Main webview not available for agent selection');
      return handleSelectionFallback(
        agentName,
        'Main webview not available',
        copyToClipboardOnFailure,
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    logger.error(CHANNEL, `Failed to select agent: ${errorMessage}`);
    return handleSelectionFallback(
      agentName,
      `Error: ${errorMessage}`,
      copyToClipboardOnFailure,
    );
  }
}
