// Standard library imports
import * as path from 'path';

// Third-party imports
import { sync as globSync } from 'glob';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { sleep } from '@utils/helpers';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
    // Check if latexindent is installed
    const showWarning = getConfig<boolean>(
      'texra.latex.showLatexindentWarning',
      true,
    );

    const workspacePath = WorkspaceFS.getPath();
    const absoluteFilePath = path.isAbsolute(filePath)
      ? filePath
      : workspacePath
        ? path.join(workspacePath, filePath)
        : path.resolve(filePath);
    const isWorkspaceFile =
      !!workspacePath && absoluteFilePath.startsWith(workspacePath);

    // Get latexindent config from settings
    const latexindentConfig = getConfig<string>(
      'texra.latex.latexindentConfig',
    );

    // Build command array - note we're using -w (overwrite) and -s (silent)
    const args = ['-w', '-s'];
    if (latexindentConfig) {
      args.push(`-l=${latexindentConfig}`);
    }
    args.push(filePath);

    const result = await runToolWithCheck('latexindent', args, {
      channel: CHANNEL,
      showError: showWarning,
    });
    if (!result || !result.success) {
      return false;
    }

    // Wait a moment for the file system to stabilize
    await sleep(100);

    // Setup cleanup patterns relative to workspace
    const fileBaseName = path.basename(absoluteFilePath, '.tex');
    const fileDir = path.dirname(absoluteFilePath);

    logger.debug(CHANNEL, `File base name: ${fileBaseName}`);
    logger.debug(CHANNEL, `File directory: ${fileDir}`);
    logger.debug(CHANNEL, `Workspace path: ${workspacePath}`);

    // Get all backup files matching the patterns, relative to workspace
    if (isWorkspaceFile && workspacePath) {
      const backupPatterns = [
        `${fileBaseName}.tex.bak*`,
        `${fileBaseName}.tex.bak`,
        `${fileBaseName}.bak*`,
        `${fileBaseName}.bak`,
      ].map((pattern) => path.join(fileDir, pattern).replace(/\\/g, '/'));

      logger.debug(
        CHANNEL,
        `Backup patterns: ${JSON.stringify(backupPatterns)}`,
      );

      for (const pattern of backupPatterns) {
        logger.debug(CHANNEL, `Searching for pattern: ${pattern}`);
        const backupFiles = globSync(pattern, {
          nodir: true,
          absolute: true,
        });

        logger.debug(
          CHANNEL,
          `Found backup files for pattern ${pattern}: ${JSON.stringify(backupFiles)}`,
        );

        for (const backupFile of backupFiles) {
          try {
            await AbsoluteFS.delete(backupFile);
            const displayPath = workspacePath
              ? WorkspaceFS.relativePath(backupFile)
              : backupFile;
            logger.debug(CHANNEL, `Removed backup file: ${displayPath}`);
          } catch (err) {
            logger.warn(
              CHANNEL,
              `Error removing backup file ${backupFile}: ${err}`,
            );
          }
        }
      }
    } else {
      logger.debug(
        CHANNEL,
        `Skipping workspace backup cleanup for ${filePath} (outside workspace)`,
      );
    }

    const indentLogPath = path.join(fileDir, 'indent.log');
    try {
      await AbsoluteFS.delete(indentLogPath);
      const displayPath = workspacePath
        ? WorkspaceFS.relativePath(indentLogPath)
        : indentLogPath;
      logger.debug(CHANNEL, `Removed indent.log at ${displayPath}`);
    } catch (err) {
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
