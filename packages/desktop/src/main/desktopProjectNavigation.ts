// Moving between a window's projects: showing one, closing one, opening a
// folder as one, and jumping to a run in one. Selection changes visibility;
// each project retains its tabs and processes, and only explicit closure
// releases its resources.

import { app } from 'electron';
import { Effect } from 'effect';

import type { ProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { ProjectBindings } from './desktopProjectBindings.js';
import type { DesktopProjectRegistry } from './desktopProjects.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';
import type { DesktopSpawn } from './desktopWindows.js';

export function createProjectNavigation(options: {
  readonly host: DesktopWindowHost;
  readonly spawn: DesktopSpawn;
  readonly projects: DesktopProjectRegistry;
  readonly bindings: ProjectBindings;
}) {
  const { host, spawn, projects, bindings } = options;
  const projectByKey = (key: string) =>
    projects.list().find((project) => project.key === key);
  /** Run a registry change on its own fiber, reporting its failure. */
  const spawnReporting = (
    program: Effect.Effect<void, Error, ProcessServices>,
  ) =>
    spawn(
      program.pipe(
        Effect.catch((error) =>
          Effect.sync(() => host.reportAsyncError(error)),
        ),
      ),
    );

  /** Open a folder as a project and show it. */
  const open = Effect.fn('desktop.openProjectAt')(function* (path: string) {
    const project = yield* projects.open(path);
    if (project.root !== undefined && project !== projects.active())
      yield* projects.activate(project.root);
  });

  return {
    open,
    select(key: string) {
      const project = projectByKey(key);
      if (
        !project ||
        project.root === undefined ||
        project === projects.active()
      )
        return;
      spawnReporting(projects.activate(project.root));
    },
    /** Show a run of a project, whichever project the window is showing. */
    reveal(key: string, runId: RunId) {
      const project =
        key === projects.fallback().key
          ? projects.fallback()
          : projectByKey(key);
      if (!project) return;
      spawnReporting(
        projects
          .activate(project.root)
          .pipe(
            Effect.andThen(
              Effect.sync(() =>
                bindings
                  .get(key)
                  ?.bridge.surfaceAction({ kind: 'select', runId }),
              ),
            ),
          ),
      );
    },
    /** The renderer reports dirtiness for the addressed project, including a
     *  hidden one. Only explicit closure releases its resources. */
    close(key: string, hasUnsavedChanges: boolean) {
      const project = projectByKey(key);
      if (!project || project.root === undefined) return;
      if (hasUnsavedChanges && host.showDiscardDialog() !== 1) return;
      spawnReporting(projects.close(project.root));
    },
    openFolder: Effect.fn('desktop.openWorkspaceFolder')(function* () {
      const selectedPath = yield* host.pickFolder(
        'Open Workspace Folder',
        projects.active().root ?? app.getPath('home'),
        ['openDirectory'],
      );
      if (!selectedPath) return;
      yield* open(selectedPath);
    }),
    /** Menu callbacks: the failure of a registry change reaches the report. */
    spawnReporting,
  };
}
