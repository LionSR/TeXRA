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
    const isWorkspaceFile =
      !!workspacePath && filePath.startsWith(workspacePath);

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
    const fileBaseName = path.basename(filePath, '.tex');
    const fileDir = path.dirname(filePath);

    logger.debug(CHANNEL, `File base name: ${fileBaseName}`);
    logger.debug(CHANNEL, `File directory: ${fileDir}`);
    logger.debug(CHANNEL, `Workspace path: ${workspacePath}`);

    const backupPatterns = [
      `${fileBaseName}.tex.bak*`,
      `${fileBaseName}.tex.bak`,
      `${fileBaseName}.bak*`,
      `${fileBaseName}.bak`,
    ];

    const cleanupTargets = new Set<string>();

    if (workspacePath && isWorkspaceFile) {
      const relativeDir = path.relative(workspacePath, fileDir);
      logger.debug(
        CHANNEL,
        `Workspace backup patterns: ${JSON.stringify(backupPatterns)}`,
      );

      for (const pattern of backupPatterns) {
        const globPattern = path.join(relativeDir, pattern).replace(/\\/g, '/');
        logger.debug(
          CHANNEL,
          `Searching workspace backups with pattern: ${globPattern}`,
        );
        const backupFiles = globSync(globPattern, {
          cwd: workspacePath,
          nodir: true,
          absolute: false,
        });

        logger.debug(
          CHANNEL,
          `Found workspace backup files: ${JSON.stringify(backupFiles)}`,
        );
        backupFiles.forEach((file) => cleanupTargets.add(file));
      }
    } else {
      logger.debug(
        CHANNEL,
        `Collecting backups outside workspace for ${filePath}`,
      );

      for (const pattern of backupPatterns) {
        const globPattern = path.join(fileDir, pattern).replace(/\\/g, '/');
        logger.debug(
          CHANNEL,
          `Searching external backups with pattern: ${globPattern}`,
        );
        const backupFiles = globSync(globPattern, {
          nodir: true,
          absolute: true,
        });

        logger.debug(
          CHANNEL,
          `Found external backup files: ${JSON.stringify(backupFiles)}`,
        );
        backupFiles.forEach((file) => cleanupTargets.add(file));
      }
    }

    for (const backupFile of cleanupTargets) {
      try {
        if (isWorkspaceFile && workspacePath) {
          await WorkspaceFS.delete(backupFile);
        } else {
          await AbsoluteFS.delete(backupFile);
        }
        logger.debug(CHANNEL, `Removed backup file: ${backupFile}`);
      } catch (err) {
        logger.warn(
          CHANNEL,
          `Error removing backup file ${backupFile}: ${err}`,
        );
      }
    }

    const indentLogPath = path.join(path.dirname(filePath), 'indent.log');
    try {
      if (isWorkspaceFile) {
        await WorkspaceFS.delete(indentLogPath);
      } else {
        await AbsoluteFS.delete(indentLogPath);
      }
      logger.debug(CHANNEL, 'Removed indent.log');
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
