// Standard library imports
import * as path from 'path';

// Third-party imports
import { sync as globSync } from 'glob';
import * as vscode from 'vscode';

// Local imports - log
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';
import { sleep } from '@utils/helpers';
import { runToolWithCheck } from '@utils/system';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

function isFileNotFound(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === 'ENOENT' || code === 'FileNotFound') {
      return true;
    }
  }
  return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
}

async function cleanupIndentLog(
  deleteFn: (path: string) => Promise<void>,
  logPath: string,
  displayPath: string,
): Promise<void> {
  try {
    await deleteFn(logPath);
    logger.debug(CHANNEL, `Removed ${displayPath}`);
  } catch (err) {
    if (isFileNotFound(err)) {
      logger.debug(CHANNEL, `No indent.log to remove at ${displayPath}`);
    } else {
      logger.warn(CHANNEL, `Error removing indent.log: ${err}`);
    }
  }
}

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
          cwd: workspacePath,
          nodir: true,
          absolute: false,
        });

        logger.debug(
          CHANNEL,
          `Found backup files for pattern ${pattern}: ${JSON.stringify(backupFiles)}`,
        );

        for (const backupFile of backupFiles) {
          try {
            await WorkspaceFS.delete(backupFile);
            logger.debug(CHANNEL, `Removed backup file: ${backupFile}`);
          } catch (err) {
            if (!isFileNotFound(err)) {
              logger.warn(
                CHANNEL,
                `Error removing backup file ${backupFile}: ${err}`,
              );
            }
          }
        }
      }
      // Clean up indent.log in the file's directory
      const relativeDir = path.relative(workspacePath, fileDir);
      const relativeIndentLog = path.join(relativeDir, 'indent.log');
      await cleanupIndentLog(
        WorkspaceFS.delete.bind(WorkspaceFS),
        relativeIndentLog,
        relativeIndentLog,
      );
    } else {
      // Skip backup cleanup for non-workspace files since glob patterns require
      // a workspace context. The batch indent command (indent.ts) handles cleanup
      // for workspace files via recursive directory traversal.
      logger.debug(
        CHANNEL,
        `Skipping backup cleanup for ${filePath} (outside workspace)`,
      );

      // Clean up indent.log for non-workspace files
      const indentLogPath = path.join(fileDir, 'indent.log');
      await cleanupIndentLog(
        AbsoluteFS.delete.bind(AbsoluteFS),
        indentLogPath,
        indentLogPath,
      );
    }

    logger.info(CHANNEL, `Indented ${filePath}`);
    return true;
  } catch (err) {
    logger.error(CHANNEL, `Error running LaTeX indent: ${toErrorMessage(err)}`);
    return false;
  }
}
