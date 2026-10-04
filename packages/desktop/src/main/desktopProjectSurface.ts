// The window's project-bound surface: the settings controllers, the settings
// view and the window title of the project the window shows. The session
// bridge and the workbench stay with their project's binding. The surface
// lives in a child of the window's scope, closed and replaced, awaited, when
// the window switches projects.

import { join } from 'node:path';

import { app, shell } from 'electron';
import { Effect, Exit, FileSystem, Scope, SubscriptionRef } from 'effect';

import type { PlatformSecrets } from '@platform/secrets';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages.js';
import {
  createDesktopSettingsIpc,
  type DesktopSettingsIpc,
  type DesktopSettingsIpcOptions,
} from './desktopSettingsIpc.js';
import { desktopSignInPresenters } from './desktopSignInPresenters.js';
import { installDesktopWindowTitle } from './desktopWindowTitle.js';
import { desktopSpawner } from './desktopWindows.js';
import type { ProjectBindings } from './desktopProjectBindings.js';
import type { DesktopPromptController } from './desktopPromptController.js';
import type { DesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import type {
  DesktopProject,
  DesktopProjectRegistry,
} from './desktopProjects.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';

export interface ProjectSurface {
  /** The settings surface of the project the window is bound to. */
  settings(): DesktopSettingsIpc | undefined;
  /** The project the window is bound to. */
  attached(): DesktopProject | undefined;
  /**
   * Bind the window to the project it shows. The old settings IPC is detached
   * first, so an attach that fails partway leaves settings messages
   * unhandled, not routed to a closed project's IPC. `documentChanged` binds
   * again for the same project: a navigation destroyed its correlations.
   */
  attach(
    documentChanged?: boolean,
  ): Effect.Effect<void, never, ProcessServices>;
}

export const openProjectSurface = Effect.fn('desktop.openProjectSurface')(
  function* (options: {
    readonly host: DesktopWindowHost;
    readonly runtime: ProcessRuntime;
    readonly projects: DesktopProjectRegistry;
    readonly bindings: ProjectBindings;
    readonly onboarding: DesktopOnboardingIpc;
    readonly promptController: DesktopPromptController;
    readonly secrets: PlatformSecrets;
    readonly resourcesPath: string;
  }): Effect.fn.Return<ProjectSurface, never, Scope.Scope> {
    const { host, runtime, projects, bindings, onboarding } = options;
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
      const postForActiveProject = (message: unknown) =>
        surfaceScope === owner && host.post(message);
      return {
        post: (message) =>
          Effect.flatMap(message, (built) =>
            Effect.sync(() => {
              postForActiveProject(built);
            }),
          ),
        notify: {
          showInfoMessage: dialogs.showInfoMessage,
          showErrorMessage: dialogs.showErrorMessage,
        },
        // The window's dialogs behind the host-neutral prompt port. The
        // renderer overlay settles a prompt it could not deliver as "no
        // answer", so `input` has no failure of its own; the native dialogs
        // reject once the window they anchor to is gone.
        prompt: {
          input: (input) =>
            options.promptController.request({
              title: input.prompt ?? 'TeXRA',
              prompt: input.prompt ?? '',
              password: input.password,
            }),
          confirm: (message, promptOptions) =>
            dialogs.confirmDialog({
              message,
              detail: promptOptions.detail,
              confirmLabel: promptOptions.confirmLabel,
            }),
          info: (message) =>
            dialogs.showInfoMessage(message).pipe(Effect.as(undefined)),
          warning: (message) =>
            dialogs.showWarningMessage(message).pipe(Effect.as(undefined)),
        },
        // The one browser hand-off every settings URL takes. Its failure
        // reaches the settings body's own report, so the opener shows no
        // dialog of its own: one failed open, one dialog.
        externalOpener: {
          openExternal: (url) => host.openExternalProgram(url, false),
        },
        openPath: previewHost.openPath,
        revealPath: (filePath) =>
          Effect.sync(() => shell.showItemInFolder(filePath)),
        // The desktop has no editor of its own and hands the path to the OS,
        // so read-only YAML is shown through a temporary copy the external
        // editor may save without touching the original.
        showReadOnlyYaml: (fileName, text) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const target = join(
              yield* fs.makeTempDirectory({ prefix: 'texra-agent-yaml-' }),
              fileName,
            );
            yield* fs.writeFileString(target, text);
            yield* previewHost.openPath(target);
          }),
        pickFolder: (title) =>
          host.pickFolder(
            title,
            projects.active().root ?? app.getPath('home'),
            ['openDirectory', 'createDirectory'],
          ),
        // Catalog refresh leaves each Surface's selections intact. Applying
        // an agent mode separately sends the chosen root to that project's
        // launcher. Each project's catalogs answer for that project: its
        // snapshot source was built over its own roots.
        refreshCatalogs: (selectedAgent) =>
          Effect.gen(function* () {
            yield* bindings.eachSnapshot(
              (snapshot) => snapshot.refreshCatalogs,
            );
            if (!selectedAgent) return;
            const binding = bindings.get(project.key);
            if (!binding || binding !== documentBinding) return;
            binding.bridge.surfaceAction({
              kind: 'launch',
              patch: { sessionType: 'chat', agent: selectedAgent },
            });
          }),
        refreshCredentialStatus: Effect.suspend(() =>
          Effect.andThen(
            bindings.eachSnapshot((snapshot) => snapshot.refreshHostBanners),
            onboarding.refreshOnboardingFunnel(),
          ),
        ),
        // Selection is the surface's: a settings jump asks the shown
        // project's surface to select the run, and reports a run the view no
        // longer holds as missing.
        revealRun: (runId) =>
          Effect.sync(() => {
            const binding = bindings.active();
            if (!binding) return 'unavailable' as const;
            const view = SubscriptionRef.getUnsafe(
              binding.project.session.view,
            );
            if (!view.runs.has(runId)) return 'missing' as const;
            binding.bridge.surfaceAction({ kind: 'select', runId });
            return 'revealed' as const;
          }),
        runLabel: (runId) =>
          SubscriptionRef.getUnsafe(projects.active().session.view).runs.get(
            runId,
          )?.label,
        stateSettingApplied: () => Effect.void,
        runInTerminal: (_name, command) =>
          Effect.sync(() => {
            if (bindings.get(project.key) !== documentBinding) return;
            host.post({
              command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND,
              session: project.key,
              initialCommand: command,
            });
          }),
        // There is no editor whose settings the LaTeX page could recommend.
        latexRecommendedStatus: () => ({
          outDir: true,
          autoRevealExclude: true,
        }),
      };
    };

    const attach = Effect.fn('desktop.attachProject')(function* (
      documentChanged = false,
    ) {
      const project = projects.active();
      if (project === attached && !documentChanged) return;
      const previous = surfaceScope;
      attached = project;
      const owner = yield* Scope.fork(windowScope);
      surfaceScope = owner;
      settings = undefined;
      if (previous) yield* Scope.close(previous, Exit.void);
      settings = yield* createDesktopSettingsIpc({
        bindings: settingsBindingsFor(project, owner),
        signInPresentation: {
          // The sign-in variant is the same program with the window's own
          // "could not open" dialog suppressed: the sign-in flow reports a
          // missing browser itself and falls back to a device code.
          openSubscriptionSignInUrl: (url) =>
            host.openExternalProgram(url, false),
          ...desktopSignInPresenters(
            host.window,
            host.previewHost.openExternal,
          ),
        },
        session: project.session,
        secrets: options.secrets,
        resourcesPath: options.resourcesPath,
        spawn: desktopSpawner(runtime, owner),
      }).pipe(
        // Gated on the same owner check as the surface's posts: the title
        // stops with the scope, and the check stops a switch's old title
        // before that close has run.
        Effect.tap(() =>
          installDesktopWindowTitle(
            host.window,
            project.session,
            project.root && project.display.name,
            () => surfaceScope === owner,
          ),
        ),
        Scope.provide(owner),
      );
    });

    return { settings: () => settings, attached: () => attached, attach };
  },
);
