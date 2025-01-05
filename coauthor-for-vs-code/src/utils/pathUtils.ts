// Standard library imports
import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { getConfig } from '../frontend-utils/commonUtils';

const CHANNEL = 'PathUtils';
logger.initializeLogging(CHANNEL);

/**
 * Get the absolute path to the agents directory, handling both absolute and relative paths.
 */
export async function getAgentsDirectory(
  context: vscode.ExtensionContext,
): Promise<string> {
  try {
    const rootPath = getConfig<string>('explorer.agentsDirectory', 'agents');

    if (rootPath && path.isAbsolute(rootPath)) {
      return rootPath;
    }

    if (!context) {
      throw new Error('Extension context required for relative paths');
    }

    const basePath = path.join(context.globalStorageUri.fsPath, rootPath);

    // Ensure the directory exists
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(basePath));
    logger.debug(CHANNEL, `Using agents directory: ${basePath}`);

    return basePath;
  } catch (err) {
    const errorMsg = `Error getting agents directory: ${err instanceof Error ? err.message : String(err)}`;
    logger.error(CHANNEL, errorMsg);
    throw new Error(errorMsg);
  }
}

/**
 * Resolve a path relative to the agents directory.
 */
export async function resolveAgentPath(
  relativePath: string,
  context: vscode.ExtensionContext,
): Promise<string> {
  const agentsDir = await getAgentsDirectory(context);
  return path.join(agentsDir, relativePath);
}
