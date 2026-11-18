import { Effect, type FileSystem, type Path } from 'effect';

import {
  DESKTOP_DOCS_URL,
  DESKTOP_LOCAL_COMMANDS,
  DESKTOP_MAIN_COMMANDS,
  type DesktopCommandId,
  type DesktopMainCommandId,
} from '../shared/desktopCommandSurface.js';
import { DESKTOP_SHELL_COMMANDS } from '../shared/desktopShellMessages.js';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { DesktopCommandRoutes } from './desktopIpcTypes.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';
import type { HostFailed } from '@texra/hosts/uiHosts';
import type { DesktopSpawn } from './desktopWindows.js';

interface DesktopShellCommandOptions {
  openExternalUrl(url: string): Effect.Effect<void, HostFailed>;
  openLogFolder(): Effect.Effect<void, HostFailed>;
  openWorkspaceFolder(): Effect.Effect<
    void,
    Error,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  >;
  onAsyncError: (error: unknown) => void;
  /** Every command's program runs on a fiber of the window's scope. */
  spawn: DesktopSpawn;
}

/**
 * The window's desktop commands as the main process sees them: the three it
 * runs itself, routed from the renderer by id, and `run`, which the native
 * menu calls for any command and which hands every other one to the renderer.
 */
export function createDesktopShellCommands(
  post: (message: DesktopPush) => void,
  options: DesktopShellCommandOptions,
): {
  run(id: DesktopCommandId): void;
  routes: DesktopCommandRoutes;
} {
  // Fire-and-forget: the program runs on its own fiber and whatever it fails
  // with reaches the window's async-error reporter.
  const programs: Record<
    DesktopMainCommandId,
    () => Effect.Effect<
      void,
      Error,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner
    >
  > = {
    [DESKTOP_LOCAL_COMMANDS.OPEN_DESKTOP_DOCS]: () =>
      options.openExternalUrl(DESKTOP_DOCS_URL),
    [DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER]: options.openLogFolder,
    [DESKTOP_LOCAL_COMMANDS.OPEN_WORKSPACE_FOLDER]: options.openWorkspaceFolder,
  };
  const runHere = (id: DesktopMainCommandId): void => {
    options.spawn(
      programs[id]().pipe(
        Effect.catch((error) => Effect.sync(() => options.onAsyncError(error))),
      ),
    );
  };
  const isMainCommand = (id: DesktopCommandId): id is DesktopMainCommandId =>
    (DESKTOP_MAIN_COMMANDS as readonly DesktopCommandId[]).includes(id);
  return {
    run: (id) => {
      if (isMainCommand(id)) runHere(id);
      else post({ command: DESKTOP_SHELL_COMMANDS.RUN_COMMAND, id });
    },
    routes: Object.fromEntries(
      DESKTOP_MAIN_COMMANDS.map((id) => [
        id,
        () => Effect.sync(() => runHere(id)),
      ]),
    ),
  };
}
