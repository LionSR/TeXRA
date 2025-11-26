// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { MAIN_VIEW_COMMANDS } from '@common/webview';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - agent (relative imports last)
import {
  RemoteAgentLoader,
  type RemoteAgentMetadata,
} from './RemoteAgentLoader';
import { RemoteAgentRegistry } from './RemoteAgentRegistry';

const CHANNEL = 'RemoteAgentUtils';
logger.initialize(CHANNEL);

/**
 * Result of loading remote agents with registration.
 */
export interface LoadedRemoteAgents {
  agents: RemoteAgentMetadata[];
  newlyRegistered: string[];
}

/**
 * Load remote agents and register any that aren't already registered.
 * This is the single source of truth for agent loading and registration.
 *
 * @returns The loaded agents and list of newly registered agent names
 */
export async function loadAndRegisterRemoteAgents(): Promise<LoadedRemoteAgents> {
  try {
    const agents = await RemoteAgentLoader.listRemoteAgents();

    if (agents.length === 0) {
      return { agents: [], newlyRegistered: [] };
    }

    // Register only unregistered agents
    const agentNames = agents.map((agent) => agent.name);
    const unregisteredAgents = agentNames.filter(
      (name) => !RemoteAgentRegistry.isRemote(name),
    );

    if (unregisteredAgents.length > 0) {
      RemoteAgentRegistry.registerMultiple(unregisteredAgents);
      logger.debug(
        CHANNEL,
        `Registered ${unregisteredAgents.length} new remote agents`,
      );
    }

    return { agents, newlyRegistered: unregisteredAgents };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(CHANNEL, `Failed to load remote agents: ${message}`);
    throw error;
  }
}

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
  } = {},
): Promise<SelectAgentResult> {
  const { showSuccessMessage = true, copyToClipboardOnFailure = false } =
    options;

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
          workflowAgent: agentName,
        },
      });

      if (showSuccessMessage) {
        void vscode.window.showInformationMessage(
          `Remote agent "${agentName}" is now selected.`,
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
