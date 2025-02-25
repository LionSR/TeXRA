// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { sync as globSync } from 'glob';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { deleteFile, getWorkspacePath } from '../utils/workspaceFileUtils';
import { executeCommand } from '../utils/execUtils';
import { checkToolInstalled } from './texTools';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
    // Check if latexindent is installed
    if (!(await checkToolInstalled('latexindent'))) {
      return false;
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      logger.error(CHANNEL, 'No workspace path found');
      return false;
    }

    // Get latexindent config from settings
    const config = vscode.workspace.getConfiguration('coauthor.latex');
    const latexindentConfig = config.get<string>('latexindentConfig');

    // Build command array - note we're using -w (overwrite) and -s (silent)
    const command = ['latexindent', '-w', '-s'];
    if (latexindentConfig) {
      command.push(`-l=${latexindentConfig}`);
    }
    command.push(`"${filePath}"`);

    const result = await executeCommand(command, { channel: CHANNEL });
    if (!result.success) {
      return false;
    }

    // Wait a moment for the file system to stabilize
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Setup cleanup patterns relative to workspace
    const fileBaseName = path.basename(filePath, '.tex');
    const fileDir = path.dirname(filePath);

    logger.debug(CHANNEL, `File base name: ${fileBaseName}`);
    logger.debug(CHANNEL, `File directory: ${fileDir}`);
    logger.debug(CHANNEL, `Workspace path: ${workspacePath}`);

    // Get all backup files matching the patterns, relative to workspace
    const backupPatterns = [
      `${fileBaseName}.tex.bak*`,
      `${fileBaseName}.tex.bak`,
      `${fileBaseName}.bak*`,
      `${fileBaseName}.bak`,
    ].map((pattern) => path.join(fileDir, pattern).replace(/\\/g, '/')); // Normalize to forward slashes for glob

    logger.debug(CHANNEL, `Backup patterns: ${JSON.stringify(backupPatterns)}`);

    // Clean up backup files from workspace directory
    for (const pattern of backupPatterns) {
      logger.debug(CHANNEL, `Searching for pattern: ${pattern}`);
      const backupFiles = globSync(pattern, {
        cwd: workspacePath,
        nodir: true,
        absolute: false, // Get paths relative to workspace
      });

      logger.debug(
        CHANNEL,
        `Found backup files for pattern ${pattern}: ${JSON.stringify(backupFiles)}`,
      );

      for (const backupFile of backupFiles) {
        try {
          await deleteFile(backupFile);
          logger.debug(CHANNEL, `Removed backup file: ${backupFile}`);
        } catch (err) {
          logger.warn(
            CHANNEL,
            `Error removing backup file ${backupFile}: ${err}`,
          );
        }
      }
    }

    // Clean up indent.log
    const indentLogPath = path.join(path.dirname(filePath), 'indent.log');
    try {
      await deleteFile(indentLogPath);
      logger.debug(CHANNEL, 'Removed indent.log');
    } catch (err) {
      // Ignore error if indent.log doesn't exist
      logger.warn(CHANNEL, `Error removing indent.log: ${err}`);
    }

    logger.info(CHANNEL, `Indented ${filePath}`);
    return true;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error running LaTeX indent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
