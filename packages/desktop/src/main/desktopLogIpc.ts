import { Data, Effect, FileSystem } from 'effect';

import type { ProcessRuntime } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  DESKTOP_LOG_COMMANDS,
  type DesktopLogSnapshot,
} from '../shared/desktopLogMessages.js';
import type { SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';

/** The clipboard write, the save dialog, or the file write behind a log
 *  action failed. */
class DesktopLogActionFailed extends Data.TaggedError(
  'DesktopLogActionFailed',
)<{
  readonly action: 'copy' | 'export';
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface DesktopLogIpcOptions {
  readLog(): DesktopLogSnapshot;
  copyLog(text: string): void;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  onAsyncError: (error: unknown) => void;
  /** Runs the copy and export actions and supplies the filesystem the export
   *  writes through. */
  runtime: ProcessRuntime;
}

export function createDesktopLogIpc(
  renderer: DesktopRenderer,
  options: DesktopLogIpcOptions,
): DesktopMessageHandler {
  function postSnapshot(): DesktopLogSnapshot {
    const log = options.readLog();
    renderer.postToRenderer({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log,
    });
    return log;
  }

  const copyLog = (text: string) =>
    Effect.try({
      try: () => options.copyLog(text),
      catch: (cause) =>
        new DesktopLogActionFailed({
          action: 'copy',
          message: toErrorMessage(cause),
          cause,
        }),
    });

  // A cancelled dialog, or one that names no file, writes nothing.
  const exportLog = (text: string) =>
    Effect.tryPromise({
      try: () =>
        options.showSaveDialog({
          title: 'Export TeXRA Desktop Log',
          defaultPath: 'texra-desktop-log.txt',
          filters: [{ name: 'Text Logs', extensions: ['txt', 'log'] }],
        }),
      catch: (cause) =>
        new DesktopLogActionFailed({
          action: 'export',
          message: `The save dialog could not be shown: ${toErrorMessage(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap(({ canceled, filePath }) =>
        canceled || !filePath
          ? Effect.void
          : FileSystem.FileSystem.use((fs) =>
              fs.writeFileString(filePath, text),
            ).pipe(
              Effect.mapError(
                (error) =>
                  new DesktopLogActionFailed({
                    action: 'export',
                    message: `The log could not be written to ${filePath}: ${toErrorMessage(error.reason.cause ?? error)}`,
                    cause: error,
                  }),
              ),
            ),
      ),
    );

  const runLogAction = (
    program: Effect.Effect<void, DesktopLogActionFailed, FileSystem.FileSystem>,
  ) =>
    options.runtime.runFork(
      program.pipe(
        Effect.catch((error: DesktopLogActionFailed) =>
          Effect.sync(() => options.onAsyncError(error)),
        ),
      ),
    );

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case DESKTOP_LOG_COMMANDS.REQUEST_LOG:
          postSnapshot();
          return true;
        case DESKTOP_LOG_COMMANDS.COPY_LOG:
          runLogAction(copyLog(postSnapshot().text));
          return true;
        case DESKTOP_LOG_COMMANDS.EXPORT_LOG:
          runLogAction(exportLog(postSnapshot().text));
          return true;
        default:
          return false;
      }
    },
  };
}
