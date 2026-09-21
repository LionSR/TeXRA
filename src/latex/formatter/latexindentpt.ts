import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { sync as globSync } from 'glob';

import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { runToolWithCheck } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '../latexLogging';

const log = createLog(CHANNEL);

export const LATEXINDENT_CONFIG_KEY = 'texra.latex.latexindentConfig';

/**
 * A missing `latexindent` is reported once per session, then stays quiet.
 * Formatting that silently does nothing is the failure mode worth avoiding;
 * a user who does not want the report picks a different LaTeX formatter,
 * which includes "none".
 */
let missingLatexindentReported = false;

const cleanupIndentLog = Effect.fn('latex.cleanupIndentLog')(function* (
  logPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // `remove` with `force` treats a path that is not there as the
  // post-condition, exactly as the facade's provider-level delete did, so
  // only a real failure is reported.
  const removed = yield* fs.remove(logPath, { force: true }).pipe(
    Effect.as(true),
    Effect.catch((err) =>
      Effect.sync(() => {
        log.warn(`Error removing indent.log: ${toErrorMessage(err)}`);
        return false;
      }),
    ),
  );
  if (removed) {
    yield* Effect.logDebug(`Removed ${logPath}`).pipe(withLogChannel(CHANNEL));
  }
});

/** Delete all files matching backup glob patterns in a directory. */
const cleanupBackupFiles = Effect.fn('latex.cleanupBackupFiles')(function* (
  fileBaseName: string,
  fileDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const backupFiles = [
    `${fileBaseName}.tex.bak*`,
    `${fileBaseName}.bak*`,
  ].flatMap((pattern) =>
    globSync(path.join(fileDir, pattern).replaceAll('\\', '/'), {
      nodir: true,
    }),
  );

  for (const backupFile of backupFiles) {
    const removed = yield* fs.remove(backupFile, { force: true }).pipe(
      Effect.as(true),
      Effect.catch((err) =>
        Effect.sync(() => {
          log.warn(
            `Error removing backup file ${backupFile}: ${toErrorMessage(err)}`,
          );
          return false;
        }),
      ),
    );
    if (removed) {
      yield* Effect.logDebug(`Removed backup file: ${backupFile}`).pipe(
        withLogChannel(CHANNEL),
      );
    }
  }
});

/**
 * `workspacePath` is the root a relative `filePath` resolves against and the
 * cwd latexindent runs in, and `latexindentConfig` the configured config-file
 * path — the caller's own session root and configuration, held as data, not
 * the roots the calling fiber happens to carry.
 */
export const runLatexIndent = Effect.fn('latex.runLatexIndent')(
  function* (
    filePath: string,
    workspacePath: string | undefined,
    latexindentConfig: string,
    settings: SettingsStores,
  ) {
    // Resolve workspace-relative paths to absolute so cleanup works correctly.
    // Some callers (latexCommands, housekeeping/indent) pass relative paths.
    const absolutePath =
      path.isAbsolute(filePath) || !workspacePath
        ? filePath
        : path.join(workspacePath, filePath);

    const args = ['-w', '-s'];
    if (latexindentConfig) {
      args.push(`-l=${latexindentConfig}`);
    }
    args.push(absolutePath);

    const result = yield* runToolWithCheck('latexindent', args, {
      channel: CHANNEL,
      cwd: workspacePath,
      // The slots the caller resolved this formatter from.
      settings,
      showError: !missingLatexindentReported,
    });
    if (result === false) missingLatexindentReported = true;
    const success = Boolean(result && result.success);

    if (success) {
      // Wait a moment for the file system to stabilize after a successful write
      yield* Effect.sleep(100);
    }

    // Always clean up backup files — latexindent creates .bak before modifying,
    // so a crash or failure can still leave orphaned backups.
    const fileBaseName = path.basename(absolutePath, '.tex');
    const fileDir = path.dirname(absolutePath);
    yield* cleanupBackupFiles(fileBaseName, fileDir);
    yield* cleanupIndentLog(path.join(fileDir, 'indent.log'));
    // latexindent may also create indent.log at the process cwd (workspace root)
    if (workspacePath && fileDir !== workspacePath) {
      yield* cleanupIndentLog(path.join(workspacePath, 'indent.log'));
    }

    if (success) {
      yield* Effect.logInfo(`Indented ${absolutePath}`).pipe(
        withLogChannel(CHANNEL),
      );
    }
    return success;
  },
  Effect.catch((err) =>
    Effect.sync(() => {
      log.error(`Error running LaTeX indent: ${toErrorMessage(err)}`);
      return false;
    }),
  ),
);
