import * as path from 'path';

import { toErrorMessage } from '@common/errors';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import { isDirectory, isFile, isSymlink } from '@common/files/fsEntryType';
import { runLatexFormatter } from '@latex/texFormatter';
import * as logger from '@logger/logUtils';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { hasExtension } from '@utils/core/pathCore';
import { EXCLUDED_DIRS } from './constants';

const CHANNEL = 'Housekeeping';
logger.initialize(CHANNEL);

export type IndentLatexResult =
  | {
      status: 'formatted';
      directory: string;
      count: number;
    }
  | {
      status: 'disabled';
      directory: string;
      count: 0;
    }
  | {
      status: 'missing-config';
      directory: string;
      count: 0;
      configPath: string;
    }
  | {
      status: 'error';
      directory: string;
      count: 0;
      error: unknown;
    };

/**
 * Formats LaTeX files in a specific directory and its subdirectories
 * @param directory The directory to process (relative to workspace). If not provided, uses the root.
 * @param progressCallback Optional callback for progress updates
 * @returns Promise<IndentLatexResult> The formatting outcome
 */
export async function indentLatexFilesInDirectory(
  directory: string = '.',
  progressCallback?: (message: string, increment?: number) => void,
): Promise<IndentLatexResult> {
  logger.debug(
    CHANNEL,
    `Starting LaTeX indentation process for directory: ${directory}`,
  );

  const formatter = workspaceSM.get<string>(
    WorkspaceStateKey.LATEX_FORMATTER,
    LATEX_CONFIG_DEFAULTS.latexFormatter,
  );
  if (formatter === 'none') {
    logger.debug(CHANNEL, 'LaTeX formatter disabled; skipping indentation');
    return { status: 'disabled', directory, count: 0 };
  }
  const configKey =
    formatter === 'tex-fmt'
      ? 'texra.latex.texfmtConfig'
      : 'texra.latex.latexindentConfig';
  const config = getConfig<string>(configKey, '');
  logger.debug(CHANNEL, `Formatter: ${formatter}, Config: ${config}`);

  if (config && !(await AbsoluteFS.exists(config))) {
    logger.error(CHANNEL, `Formatter config file not found at ${config}`);
    return {
      status: 'missing-config',
      directory,
      count: 0,
      configPath: config,
    };
  }

  let indentedCount = 0;

  async function walkDirectory(
    dirPath: string,
    onFile: (fullPath: string, name: string) => Promise<void>,
  ): Promise<void> {
    const entries = await WorkspaceFS.readDir(dirPath);
    for (const [name, type] of entries) {
      if (EXCLUDED_DIRS.has(name.toLowerCase()) || name.includes('Diffs')) {
        continue;
      }

      // Skip symlinks to avoid cycles; we have no realpath/visited guard.
      if (isSymlink(type)) {
        continue;
      }

      const fullPath = path.join(dirPath, name);

      if (isDirectory(type)) {
        await walkDirectory(fullPath, onFile);
      } else if (isFile(type)) {
        await onFile(fullPath, name);
      }
    }
  }

  try {
    await walkDirectory(directory, async (fullPath, name) => {
      if (!hasExtension(name, '.tex')) return;

      progressCallback?.(`Indenting ${path.basename(fullPath)}...`, 0);
      logger.debug(CHANNEL, `Processing file: ${fullPath}`);

      try {
        if (await runLatexFormatter(fullPath)) {
          logger.info(CHANNEL, `Successfully formatted: ${fullPath}`);
          indentedCount++;
        } else {
          logger.error(CHANNEL, `Failed to format ${fullPath}`);
        }
      } catch (err) {
        logger.error(
          CHANNEL,
          `Error formatting file ${fullPath}: ${toErrorMessage(err)}`,
        );
      }
    });

    logger.info(
      CHANNEL,
      `${indentedCount} .tex files have been formatted in ${directory}`,
    );
    return { status: 'formatted', directory, count: indentedCount };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error during indentation process: ${toErrorMessage(err)}`,
    );
    return { status: 'error', directory, count: 0, error: err };
  }
}
