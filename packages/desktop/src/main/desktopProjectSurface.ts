// The window's project-bound surface: the settings controllers, the settings
// view and the window title of the project the window shows. The session
// bridge and the workbench stay with their project's binding. The surface
// lives in a child of the window's scope, closed and replaced, awaited, when
// the window switches projects.

import { app, shell } from 'electron';
import { Effect, Exit, Scope } from 'effect';

import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages.js';
import {
  createDesktopSettingsIpc,
  type DesktopSettingsIpc,
  type DesktopSettingsIpcOptions,
} from './desktopSettingsIpc.js';
import { desktopSignInPresenters } from './desktopSignInPresenters.js';
import { installDesktopWindowTitle } from './desktopWindowTitle.js';
import { desktopSpawner } from './desktopWindows.js';
import { agentDocumentForPath } from '@texra/controllers/session/workspaceFileRequest';
import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import type { ProcessRuntime, ProcessServices } from '@texra-ai/harness/host';
import type { ProjectBindings } from './desktopProjectBindings.js';
import type { makeDesktopPrompts } from './desktopPromptController.js';
import type {
  DesktopProject,
  DesktopProjectRegistry,
} from './desktopProjects.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';
import type { DesktopPush } from '../shared/desktopOutboundMessages.js';

export interface ProjectSurface {
  /** The settings surface of the project the window is bound to. */
  settings(): DesktopSettingsIpc | undefined;
  /** The project the window is bound to. */
  attached(): DesktopProject | undefined;
  /**
   * Bind the window to the project it shows. The old settings IPC is detached
   * first, so an attach that fails partway leaves settings messages
   * unhandled, not routed to a closed project's IPC.
   */
  attach(): Effect.Effect<void, never, ProcessServices>;
  /** Bind again to the same project: a navigation destroyed its
   *  correlations. */
  reattach(): Effect.Effect<void, never, ProcessServices>;
}

export const openProjectSurface = Effect.fn('desktop.openProjectSurface')(
  function* (options: {
    readonly host: DesktopWindowHost;
    readonly runtime: ProcessRuntime;
    readonly projects: DesktopProjectRegistry;
    readonly bindings: ProjectBindings;
    readonly promptController: Effect.Success<
      ReturnType<typeof makeDesktopPrompts>
    >;
  }): Effect.fn.Return<ProjectSurface, never, Scope.Scope> {
    const { host, runtime, projects, bindings } = options;
    const windowScope = yield* Scope.Scope;
    let attached: DesktopProject | undefined;
    let surfaceScope: Scope.Closeable | undefined;
    let settings: DesktopSettingsIpc | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        attached = undefined;
        settings = undefined;
      }),
    );

    const settingsBindingsFor = (
      project: DesktopProject,
      owner: Scope.Closeable,
    ): DesktopSettingsIpcOptions['bindings'] => {
      const documentBinding = bindings.get(project.key);
      const { dialogs, previewHost } = host;
      const postForActiveProject = (message: DesktopPush): void => {
        if (surfaceScope === owner) host.post(message);
      };
      /** Open the agent definition at `filePath` as a document, or, when
       *  the catalog holds none there, run `otherwise`. */
      const openAgentDocument = <E, R>(
        filePath: string,
        otherwise: Effect.Effect<void, E, R>,
      ) =>
        Effect.flatMap(agentDocumentForPath(filePath), (target) =>
          target
            ? Effect.sync(() => {
                postForActiveProject({
                  command: DESKTOP_WORKSPACE_COMMANDS.OPEN_DOCUMENT,
                  session: project.key,
                  target,
                });
              })
            : otherwise,
        );
      return {
        post: (message) =>
          Effect.flatMap(message, (built) =>
            Effect.sync(() => {
              postForActiveProject(built);
            }),
          ),
        // The window's dialogs behind the host-neutral port. The renderer
        // overlay answers a prompt it could not deliver with "no answer", so
        // `input` has no failure of its own; the native confirmation fails
        // once the window it anchors to is gone.
        dialogs: {
          notify: (level, message) => dialogs.notify(level, message),
          confirm: (question) => dialogs.confirm(question),
          input: (field) =>
            options.promptController.request({
              title: field.prompt,
              prompt: field.prompt,
              password: field.secret,
            }),
        },
        // The one browser hand-off every settings URL takes. Its failure
        // reaches the settings body's own report, so the opener shows no
        // dialog of its own: one failed open, one dialog.
        externalOpener: {
          openExternal: host.openExternalUrl,
        },
        openPath: (filePath) =>
          openAgentDocument(
            filePath,
            host.presented(previewHost.openPath(filePath)),
          ),
        revealPath: (filePath) =>
          Effect.sync(() => shell.showItemInFolder(filePath)),
        showReadOnlyYaml: (filePath) =>
          openAgentDocument(
            filePath,
            Effect.fail(
              new SettingsRequestFailed({
                message:
                  'This agent definition is no longer in the catalog. Refresh Settings and try again.',
              }),
            ),
          ),
        pickFolder: (title) =>
          host.pickFolder(
            title,
            projects.active().root ?? app.getPath('home'),
            ['openDirectory', 'createDirectory'],
          ),
        // The run verbs of the project these settings belong to, even while
        // the window is switching to another; a released binding's bridge
        // has no port left, so a late verb reaches no surface.
        ...(documentBinding?.settingsRuns ?? {
          revealRun: () => Effect.succeed('unavailable' as const),
          runLabel: () => undefined,
        }),
        runInTerminal: (_name, command) =>
          Effect.sync(() => {
            if (bindings.get(project.key) !== documentBinding) return;
            host.post({
              command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND,
              session: project.key,
              initialCommand: command,
            });
          }),
      };
    };

    const attach = Effect.fn('desktop.attachProject')(function* () {
      const project = projects.active();
      if (project === attached) return;
      const previous = surfaceScope;
      attached = project;
      const owner = yield* Scope.fork(windowScope);
      surfaceScope = owner;
      settings = undefined;
      if (previous) yield* Scope.close(previous, Exit.void);
      settings = yield* createDesktopSettingsIpc({
        bindings: settingsBindingsFor(project, owner),
        signInPresentation: {
          // The sign-in flow reports a missing browser itself and falls back
          // to a device code, so the window shows no dialog of its own.
          openSubscriptionSignInUrl: host.openExternalUrl,
          ...desktopSignInPresenters(host.window, (url) =>
            host.presented(host.openExternalUrl(url)),
          ),
        },
        roots: project.roots,
        spawn: desktopSpawner(runtime, owner, project.root),
      }).pipe(
        Effect.tap(() => installDesktopWindowTitle(host.window, project)),
        Scope.provide(owner),
      );
    });

    return {
      settings: () => settings,
      attached: () => attached,
      attach,
      reattach: () =>
        Effect.suspend(() => {
          attached = undefined;
          return attach();
        }),
    };
  },
);
