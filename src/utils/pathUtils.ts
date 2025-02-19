// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { getConfig } from '../frontend-utils/commonUtils';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);

/**
 * Get the absolute path to the built-in agents directory in global storage.
 */
export async function getBuiltInAgentsDirectory(
  context: vscode.ExtensionContext,
): Promise<string> {
  if (!context) {
    throw new Error('Extension context required for built-in agents');
  }

  const basePath = path.join(context.globalStorageUri.fsPath, 'agents');

  // Ensure the directory exists
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(basePath));
  logger.debug(CHANNEL, `Using built-in agents directory: ${basePath}`);

  return basePath;
}

/**
 * Get the absolute path to the custom agents directory from configuration.
 * Returns empty string if not configured or invalid.
 */
export async function getCustomAgentsDirectory(): Promise<string> {
  const customPath = getConfig<string>('explorer.agentsDirectory', '');

  if (!customPath) {
    return '';
  }

  if (!path.isAbsolute(customPath)) {
    logger.error(
      CHANNEL,
      `Custom agents directory must be an absolute path: ${customPath}`,
    );
    vscode.window.showErrorMessage(
      'Custom agents directory must be an absolute path',
    );
    return '';
  }

  return customPath;
}

/**
 * Get the absolute path to the agents directory, prioritizing custom over built-in.
 * This maintains backward compatibility for existing code.
 */
export async function getAgentsDirectory(
  context: vscode.ExtensionContext,
): Promise<string> {
  const customDir = await getCustomAgentsDirectory();
  if (customDir) {
    return customDir;
  }
  return getBuiltInAgentsDirectory(context);
}
