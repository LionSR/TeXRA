// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { getConfig } from '../utils/configUtils';

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

/**
 * Prompt the user to select a folder for custom agents and persist the
 * chosen path in the workspace configuration.
 * @returns The selected folder path or undefined if the user cancelled.
 */
export async function promptForCustomAgentsDirectory(): Promise<string | undefined> {
  const folder = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select Folder',
  });

  if (!folder || folder.length === 0) {
    return undefined;
  }

  const selectedPath = folder[0].fsPath;

  // Create directory if it doesn't exist
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(selectedPath));

  const config = vscode.workspace.getConfiguration();
  await config.update(
    'texra.explorer.agentsDirectory',
    selectedPath,
    vscode.ConfigurationTarget.Workspace,
  );

  return selectedPath;
}

/**
 * Ensure that a custom agents directory is configured. If not, prompt the user
 * to select one.
 * @returns The configured directory path or undefined if none could be obtained.
 */
export async function getOrPromptForCustomAgentsDirectory(): Promise<string | undefined> {
  const current = await getCustomAgentsDirectory();
  if (current) {
    return current;
  }
  return promptForCustomAgentsDirectory();
}
