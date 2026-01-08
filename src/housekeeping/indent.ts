// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { showLoggedErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { runLatexFormatter } from '@latex/texFormatter';

// Local imports - housekeeping
import { EXCLUDED_DIRS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

/**
 * Formats LaTeX files in a specific directory and its subdirectories
 * @param directory The directory to process (relative to workspace). If not provided, uses the root.
 * @param progressCallback Optional callback for progress updates
 * @returns Promise<number> The number of files formatted
 */
export async function indentLatexFilesInDirectory(
  directory: string = '.',
  progressCallback?: (message: string, increment?: number) => void,
): Promise<number> {
  logger.debug(
    CHANNEL,
    `Starting LaTeX indentation process for directory: ${directory}`,
  );

  const formatter = getConfig<string>('texra.latex.formatter', 'latexindent');
  if (formatter === 'none') {
    logger.debug(CHANNEL, 'LaTeX formatter disabled; skipping indentation');
    return 0;
  }
  const configKey =
    formatter === 'tex-fmt'
      ? 'texra.latex.texfmtConfig'
      : 'texra.latex.latexindentConfig';
  const config = getConfig<string>(configKey, '');
  logger.debug(CHANNEL, `Formatter: ${formatter}, Config: ${config}`);

  if (config) {
    const configExists = await AbsoluteFS.exists(config);
    if (!configExists) {
      logger.error(
        CHANNEL,
        `Error: Formatter config file not found at ${config}`,
      );
      vscode.window.showErrorMessage(
        `Formatter config file not found at ${config}`,
      );
      return 0;
    }
  }

  let indentedCount = 0;

  const walkDirectory = async (
    dirPath: string,
    onFile: (fullPath: string, name: string) => Promise<void>,
  ) => {
    const entries = await WorkspaceFS.readDir(dirPath);
    for (const [name, type] of entries) {
      if (EXCLUDED_DIRS.has(name.toLowerCase())) {
        continue;
      }
      if (name.includes('Diffs')) {
        continue;
      }

      const fullPath = path.join(dirPath, name);

      if (type === vscode.FileType.Directory) {
        await walkDirectory(fullPath, onFile);
      } else if (type === vscode.FileType.File) {
        await onFile(fullPath, name);
      }
    }
  };

  try {
    await walkDirectory(directory, async (fullPath, name) => {
      if (!name.endsWith('.tex')) {
        return;
      }
      if (progressCallback) {
        progressCallback(`Indenting ${path.basename(fullPath)}...`, 0);
      }

      logger.debug(CHANNEL, `Processing file: ${fullPath}`);
      try {
        const success = await runLatexFormatter(fullPath);
        if (success) {
          logger.info(CHANNEL, `Successfully formatted: ${fullPath}`);
          indentedCount++;
        } else {
          logger.error(CHANNEL, `Failed to format ${fullPath}`);
        }
      } catch (err) {
        logger.error(CHANNEL, `Error formatting file ${fullPath}: ${err}`);
      }
    });

    await walkDirectory(directory, async (fullPath, name) => {
      if (
        name.endsWith('.bak') ||
        name.endsWith('.bak0') ||
        name.endsWith('.bak1') ||
        name === 'indent.log'
      ) {
        logger.debug(CHANNEL, `Found cleanup file: ${fullPath}`);
        await WorkspaceFS.delete(fullPath);
      }
    });

    logger.info(
      CHANNEL,
      `${indentedCount} .tex files have been formatted in ${directory}`,
    );
    return indentedCount;
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'Error during indentation process',
      err,
    );
    return 0;
  }
}

/**
 * Indents all LaTeX files in the workspace
 */
export async function runIndentTeX(): Promise<void> {
  await indentLatexFilesInDirectory('.');
}
