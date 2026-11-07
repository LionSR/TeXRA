import { basename, dirname } from 'node:path';
import { Effect, FiberHandle, FileSystem, Schema, Stream } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';

import {
  DESKTOP_LOG_COMMANDS,
  DesktopFollowLogMessageSchema,
  type DesktopLogSnapshot,
} from '../shared/desktopLogMessages.js';
import type { SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import {
  parsedRoute,
  type DesktopCommandRoutes,
  type DesktopRenderer,
} from './desktopIpcTypes.js';

/** How long the log file must stay quiet before a follow pushes it: a burst
 *  of entries is one repaint. */
const LOG_FOLLOW_QUIET_MS = 300;

/** The clipboard write, the save dialog, or the file write behind a log
 *  action failed. */
class DesktopLogActionFailed extends Schema.TaggedError<DesktopLogActionFailed>()(
  'DesktopLogActionFailed',
  {
    action: Schema.Literals(['copy', 'export']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface DesktopLogIpcOptions {
  readLog(): DesktopLogSnapshot;
  /** The log file's real path; the snapshot's is redacted for display. */
  logFile(): string;
  /** The window's one follow of the log file, run while its Logs tab is
   *  shown; closing the window interrupts it. */
  following: FiberHandle.FiberHandle<void>;
  copyLog(text: string): void;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
}

export function createDesktopLogIpc(
  renderer: DesktopRenderer,
  options: DesktopLogIpcOptions,
): DesktopCommandRoutes {
  function postSnapshot(): DesktopLogSnapshot {
    const log = options.readLog();
    renderer.postToRenderer({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log,
    });
    return log;
  }

  /** Push the log now, then each time its file changes. A watch the OS
   *  refuses ends the follow with a warning; Refresh still reads the log. */
  const follow = Effect.suspend(() => {
    postSnapshot();
    const path = options.logFile();
    return FileSystem.FileSystem.use((fs) =>
      Stream.runForEach(
        fs.watch(dirname(path)).pipe(
          Stream.filter((event) => basename(event.path) === basename(path)),
          Stream.debounce(LOG_FOLLOW_QUIET_MS),
        ),
        () => Effect.sync(postSnapshot),
      ),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `The desktop log is no longer followed: ${toErrorMessage(error)}`,
        ),
      ),
    );
  });

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

  return {
    [DESKTOP_LOG_COMMANDS.REQUEST_LOG]: () => Effect.sync(postSnapshot),
    [DESKTOP_LOG_COMMANDS.FOLLOW_LOG]: parsedRoute(
      DesktopFollowLogMessageSchema,
      ({ following }) =>
        following
          ? Effect.asVoid(FiberHandle.run(options.following, follow))
          : FiberHandle.clear(options.following),
    ),
    [DESKTOP_LOG_COMMANDS.COPY_LOG]: () =>
      Effect.suspend(() => copyLog(postSnapshot().text)),
    [DESKTOP_LOG_COMMANDS.EXPORT_LOG]: () =>
      Effect.suspend(() => exportLog(postSnapshot().text)),
  };
}
