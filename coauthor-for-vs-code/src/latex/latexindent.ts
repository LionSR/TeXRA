// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { sync as globSync } from 'glob';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { deleteFile } from '../utils/fileUtils';
import { executeCommand } from '../utils/execUtils';

const CHANNEL = 'LaTeX';
logger.initializeLogging(CHANNEL);

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
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

    // Get all backup files matching the patterns, relative to workspace
    const backupPatterns = [
      path.join(fileDir, `${fileBaseName}.tex.bak*`),
      path.join(fileDir, `${fileBaseName}.tex.bak`),
      path.join(fileDir, `${fileBaseName}.bak*`),
      path.join(fileDir, `${fileBaseName}.bak`),
    ];

    // Clean up backup files from workspace directory
    for (const pattern of backupPatterns) {
      const backupFiles = globSync(pattern, {
        cwd: process.cwd(),
        absolute: false,
      });

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
