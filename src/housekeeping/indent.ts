// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { deleteFile, readDirectory } from '../utils/workspaceFileUtils';
import { fileExistsAbsolute } from '../utils/absoluteFileUtils';
import { getConfig } from '../utils/configUtils';
import { executeCommand } from '../utils/execUtils';

// Local imports - housekeeping
import { EXCLUDED_DIRS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export async function runIndentTeX(): Promise<void> {
  logger.debug(CHANNEL, 'Starting LaTeX indentation process');

  const config = getConfig<string>('latex.latexindentConfig', '');
  logger.debug(CHANNEL, `LaTeX indent config: ${config}`);

  if (config) {
    // Check if config file exists using fileExistsAbsolute
    const configExists = await fileExistsAbsolute(config);
    if (!configExists) {
      logger.error(
        CHANNEL,
        `Error: Latexindent config file not found at ${config}`,
      );
      vscode.window.showErrorMessage(
        `Latexindent config file not found at ${config}`,
      );
      return;
    }
  }

  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (EXCLUDED_DIRS.has(name.toLowerCase())) {
          continue;
        }
        if (name.includes('Diffs')) {
          continue;
        }

        const fullPath = path.join(dirPath, name);

        if (type === vscode.FileType.Directory) {
          await processDirectory(fullPath);
        } else if (type === vscode.FileType.File && name.endsWith('.tex')) {
          logger.debug(CHANNEL, `Processing file: ${fullPath}`);
          try {
            const command = [
              'latexindent',
              `"${fullPath}"`,
              '-w', // Write to file
              '-s', // Silent mode
              config ? `-l="${config}"` : '', // Use absolute config path directly
            ]
              .filter(Boolean)
              .join(' ');

            logger.debug(CHANNEL, `Executing command: ${command}`);
            const result = await executeCommand(command, { channel: CHANNEL });
            if (!result.success) {
              logger.error(CHANNEL, `Command error: ${result.stderr}`);
              continue;
            }
            if (result.stdout) {
              logger.debug(CHANNEL, `Command output: ${result.stdout}`);
            }
            if (result.stderr) {
              logger.debug(CHANNEL, `Command stderr: ${result.stderr}`);
            }
            logger.info(CHANNEL, `Successfully indented: ${fullPath}`);
          } catch (err) {
            logger.error(CHANNEL, `Error indenting file ${fullPath}: ${err}`);
            continue;
          }
        }
      }
    } catch (err) {
      logger.error(CHANNEL, `Error processing directory ${dirPath}: ${err}`);
    }
  };

  try {
    await processDirectory('.');

    // Clean up temporary files recursively
    const processCleanup = async (dirPath: string) => {
      try {
        const entries = await readDirectory(dirPath);
        for (const [name, type] of entries) {
          if (EXCLUDED_DIRS.has(name.toLowerCase())) {
            continue;
          }
          if (name.includes('Diffs')) {
            continue;
          }

          const fullPath = path.join(dirPath, name);

          if (type === vscode.FileType.Directory) {
            await processCleanup(fullPath);
          } else if (type === vscode.FileType.File) {
            // Check for temporary files
            if (
              name.endsWith('.bak') ||
              name.endsWith('.bak0') ||
              name.endsWith('.bak1') ||
              name === 'indent.log'
            ) {
              logger.debug(CHANNEL, `Found cleanup file: ${fullPath}`);
              await deleteFile(fullPath);
            }
          }
        }
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error during cleanup in directory ${dirPath}: ${err}`,
        );
      }
    };

    // Start cleanup from workspace root
    await processCleanup('.');

    logger.info(CHANNEL, 'All .tex files have been indented');
  } catch (err) {
    logger.error(CHANNEL, `Error during indentation process: ${err}`);
    vscode.window.showErrorMessage(`Error during indentation: ${err}`);
  }
}
