import * as path from 'node:path';

import { sync as globSync } from 'glob';

import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { delay } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';

const CHANNEL = 'LaTeXCommands';

export const LATEXINDENT_CONFIG_KEY = 'texra.latex.latexindentConfig';

/**
 * A missing `latexindent` is reported once per session, then stays quiet.
 * Formatting that silently does nothing is the failure mode worth avoiding;
 * a user who does not want the report picks a different LaTeX formatter,
 * which includes "none".
 */
let missingLatexindentReported = false;

async function cleanupIndentLog(logPath: string): Promise<void> {
  try {
    await AbsoluteFS.delete(logPath);
    logger.debug(CHANNEL, `Removed ${logPath}`);
  } catch (err) {
    if (isFileNotFoundError(err)) {
      logger.debug(CHANNEL, `No indent.log to remove at ${logPath}`);
    } else {
      logger.warn(CHANNEL, `Error removing indent.log: ${toErrorMessage(err)}`);
    }
  }
}

/** Delete all files matching backup glob patterns in a directory. */
async function cleanupBackupFiles(
  fileBaseName: string,
  fileDir: string,
): Promise<void> {
  const backupFiles = [
    `${fileBaseName}.tex.bak*`,
    `${fileBaseName}.bak*`,
  ].flatMap((pattern) =>
    globSync(path.join(fileDir, pattern).replaceAll('\\', '/'), {
      nodir: true,
    }),
  );

  for (const backupFile of backupFiles) {
    try {
      await AbsoluteFS.delete(backupFile);
      logger.debug(CHANNEL, `Removed backup file: ${backupFile}`);
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        logger.warn(
          CHANNEL,
          `Error removing backup file ${backupFile}: ${toErrorMessage(err)}`,
        );
      }
    }
  }
}

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
    // Resolve workspace-relative paths to absolute so cleanup works correctly.
    // Some callers (latexCommands, housekeeping/indent) pass relative paths.
    const workspacePath = WorkspaceFS.getPath();
    const absolutePath =
      path.isAbsolute(filePath) || !workspacePath
        ? filePath
        : path.join(workspacePath, filePath);

    const latexindentConfig = getConfig<string>(LATEXINDENT_CONFIG_KEY);

    const args = ['-w', '-s'];
    if (latexindentConfig) {
      args.push(`-l=${latexindentConfig}`);
    }
    args.push(absolutePath);

    const result = await runToolWithCheck('latexindent', args, {
      channel: CHANNEL,
      showError: !missingLatexindentReported,
    });
    if (result === false) missingLatexindentReported = true;
    const success = Boolean(result && result.success);

    if (success) {
      // Wait a moment for the file system to stabilize after a successful write
      await delay(100);
    }

    // Always clean up backup files — latexindent creates .bak before modifying,
    // so a crash or failure can still leave orphaned backups.
    const fileBaseName = path.basename(absolutePath, '.tex');
    const fileDir = path.dirname(absolutePath);
    await cleanupBackupFiles(fileBaseName, fileDir);
    await cleanupIndentLog(path.join(fileDir, 'indent.log'));
    // latexindent may also create indent.log at the process cwd (workspace root)
    if (workspacePath && fileDir !== workspacePath) {
      await cleanupIndentLog(path.join(workspacePath, 'indent.log'));
    }

    if (success) {
      logger.info(CHANNEL, `Indented ${absolutePath}`);
    }
    return success;
  } catch (err) {
    logger.error(CHANNEL, `Error running LaTeX indent: ${toErrorMessage(err)}`);
    return false;
  }
}
