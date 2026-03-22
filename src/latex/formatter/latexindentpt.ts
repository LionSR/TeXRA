// Standard library imports
import * as path from 'path';

// Third-party imports
import { sync as globSync } from 'glob';

// Local imports - log
import { isFileNotFoundError, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { delay } from '@utils/core';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

async function cleanupIndentLog(
  deleteFn: (path: string) => Promise<void>,
  logPath: string,
): Promise<void> {
  try {
    await deleteFn(logPath);
    logger.debug(CHANNEL, `Removed ${logPath}`);
  } catch (err) {
    if (isFileNotFoundError(err)) {
      logger.debug(CHANNEL, `No indent.log to remove at ${logPath}`);
    } else {
      logger.warn(CHANNEL, `Error removing indent.log: ${err}`);
    }
  }
}

/** Delete all files matching backup glob patterns in a directory. */
async function cleanupBackupFiles(
  fileBaseName: string,
  fileDir: string,
  deleteFn: (path: string) => Promise<void>,
  globOptions?: Parameters<typeof globSync>[1],
): Promise<void> {
  const backupPatterns = [
    `${fileBaseName}.tex.bak*`,
    `${fileBaseName}.bak*`,
  ].map((pattern) => path.join(fileDir, pattern).replaceAll('\\', '/'));

  for (const pattern of backupPatterns) {
    logger.debug(CHANNEL, `Searching for pattern: ${pattern}`);
    const backupFiles = globSync(pattern, { nodir: true, ...globOptions });

    logger.debug(
      CHANNEL,
      `Found backup files for pattern ${pattern}: ${JSON.stringify(backupFiles)}`,
    );

    for (const backupFile of backupFiles) {
      try {
        await deleteFn(backupFile);
        logger.debug(CHANNEL, `Removed backup file: ${backupFile}`);
      } catch (err) {
        if (!isFileNotFoundError(err)) {
          logger.warn(
            CHANNEL,
            `Error removing backup file ${backupFile}: ${err}`,
          );
        }
      }
    }
  }
}

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
    const showWarning = getConfig<boolean>(
      'texra.latex.showLatexindentWarning',
      true,
    );

    const workspacePath = WorkspaceFS.getPath();
    const isWorkspaceFile =
      workspacePath &&
      (filePath === workspacePath ||
        filePath.startsWith(workspacePath + path.sep));

    const latexindentConfig = getConfig<string>(
      'texra.latex.latexindentConfig',
    );

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
    await delay(100);

    // Setup cleanup patterns relative to workspace
    const fileBaseName = path.basename(filePath, '.tex');
    const fileDir = path.dirname(filePath);

    logger.debug(CHANNEL, `File base name: ${fileBaseName}`);
    logger.debug(CHANNEL, `File directory: ${fileDir}`);
    logger.debug(CHANNEL, `Workspace path: ${workspacePath}`);

    // Clean up backup files and indent.log
    if (isWorkspaceFile && workspacePath) {
      await cleanupBackupFiles(
        fileBaseName,
        fileDir,
        WorkspaceFS.delete.bind(WorkspaceFS),
        { cwd: workspacePath, absolute: false },
      );
      const relativeDir = path.relative(workspacePath, fileDir);
      await cleanupIndentLog(
        WorkspaceFS.delete.bind(WorkspaceFS),
        path.join(relativeDir, 'indent.log'),
      );
    } else {
      await cleanupBackupFiles(
        fileBaseName,
        fileDir,
        AbsoluteFS.delete.bind(AbsoluteFS),
      );
      await cleanupIndentLog(
        AbsoluteFS.delete.bind(AbsoluteFS),
        path.join(fileDir, 'indent.log'),
      );
    }

    logger.info(CHANNEL, `Indented ${filePath}`);
    return true;
  } catch (err) {
    logger.error(CHANNEL, `Error running LaTeX indent: ${toErrorMessage(err)}`);
    return false;
  }
}
