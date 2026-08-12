// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';

const DEFAULT_CHANNEL = 'commandUtils';

/** Execute a VS Code command and handle any errors. */
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

/** Get the main webview view instance. */
export async function getMainWebview(
  channel: string = DEFAULT_CHANNEL,
): Promise<vscode.WebviewView | undefined> {
  return safeExecuteCommand<vscode.WebviewView>(
    'texra.getWebviewView',
    [],
    channel,
  );
}
