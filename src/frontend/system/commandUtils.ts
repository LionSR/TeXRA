// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@common/errors';

const DEFAULT_CHANNEL = 'commandUtils';

/**
 * Execute a VS Code command and handle any errors.
 * @param command Command identifier
 * @param args Arguments to pass to the command
 * @param channel Channel for logging errors (defaults to 'commandUtils')
 */
export async function safeExecuteCommand<T>(
  command: string,
  args: unknown[] = [],
  channel: string = DEFAULT_CHANNEL,
): Promise<T | undefined> {
  try {
    return await vscode.commands.executeCommand<T>(command, ...args);
  } catch (err) {
    await showLoggedErrorMessage(
      channel,
      `Error executing command ${command}`,
      err,
    );
    return undefined;
  }
}

/**
 * Get the main webview view instance.
 * @param channel Channel for logging errors (defaults to 'commandUtils')
 */
export async function getMainWebview(
  channel: string = DEFAULT_CHANNEL,
): Promise<vscode.WebviewView | undefined> {
  return safeExecuteCommand<vscode.WebviewView>(
    'texra.getWebviewView',
    [],
    channel,
  );
}
