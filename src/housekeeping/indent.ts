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

/**
 * Indents LaTeX files in a specific directory and its subdirectories
 * @param directory The directory to process (relative to workspace). If not provided, uses the root.
 * @param progressCallback Optional callback for progress updates
 * @returns Promise<number> The number of files indented
 */
export async function indentLatexFilesInDirectory(
  directory: string = '.',
  progressCallback?: (message: string, increment?: number) => void,
): Promise<number> {
  logger.debug(
    CHANNEL,
    `Starting LaTeX indentation process for directory: ${directory}`,
  );

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
      return 0;
    }
  }

  let indentedCount = 0;

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
          if (progressCallback) {
            progressCallback(`Indenting ${path.basename(fullPath)}...`, 0);
          }

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
            indentedCount++;
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
    await processDirectory(directory);

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

    // Start cleanup from the specified directory
    await processCleanup(directory);

    logger.info(
      CHANNEL,
      `${indentedCount} .tex files have been indented in ${directory}`,
    );
    return indentedCount;
  } catch (err) {
    logger.error(CHANNEL, `Error during indentation process: ${err}`);
    vscode.window.showErrorMessage(`Error during indentation: ${err}`);
    return 0;
  }
}

/**
 * Indents all LaTeX files in the workspace
 */
export async function runIndentTeX(): Promise<void> {
  await indentLatexFilesInDirectory('.');
}
