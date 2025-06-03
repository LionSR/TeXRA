// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

const CHANNEL = 'commandUtils';
logger.initialize(CHANNEL);

/**
 * Execute a VS Code command and handle any errors.
 * @param channel Optional channel for logging errors
 * @param command Command identifier
 * @param args Arguments to pass to the command
 */
export async function safeExecuteCommand<T>(
  command: string,
  args: any[] = [],
  channel: string = CHANNEL,
): Promise<T | undefined> {
  try {
    return await vscode.commands.executeCommand<T>(command, ...args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(channel, `Error executing command ${command}: ${message}`);
    vscode.window.showErrorMessage(`Failed to execute command: ${command}`);
    return undefined;
  }
}
