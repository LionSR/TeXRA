import { app } from 'electron';
import { Effect, ManagedRuntime, Scope } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/worldline';
import { type ProcessServices } from '@texra-ai/worldline/host';
import { withForkFailureReporting } from '@texra-ai/worldline/transcript';
import { nodeFileServices } from '@texra-ai/worldline/node';
import { openProjectRoots } from '@texra/controllers/session/openProjectSession';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import { openTexraGlobalConfigStore } from '@texra/platform/defaults/nodeStores';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  checkResourcesPath,
  texraProcessLayer,
} from '@texra/controllers/texraProcessLayer';

// Local file imports
import { withLogChannel } from '@texra-ai/worldline/plugins';
import { adoptLoginShellEnvironment } from '@texra/platform/defaults/loginShellEnvironment';
import { desktopLayout, type DesktopLayout } from './paths.js';
import type { ConfigStore } from '@texra-ai/worldline/node';
interface ElectronPlatformInitResult {
  /**
   * The no-workspace roots: what the window shows before a folder is open,
   * and what every project's roots are built beside.
   */
  processRoots: WorkspaceRoots;
  /**
   * The store over the global config file. Every project's config provider
   * layers its own workspace store over this one instance, so a global
   * setting changed from one project is what the others read.
   */
  globalConfigStore: ConfigStore;
  /**
   * Desktop's memory/history/executions data root, the CLI's `~/.texra`.
   * Threaded out so the project registry gets it from one owner instead of
   * re-resolving it — this root no longer lives under `userData` (#7987).
   */
  dataRoot: string;
  /** Where this build's files are. */
  layout: DesktopLayout;
}

export const initializeElectronPlatform = Effect.fn(
  'initializeElectronPlatform',
)(function* (mainDir: string) {
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` so a workspace worked on from both hosts shows one history.
  const dataRoot = defaultNodeStorageRoot();
  // The process identity and application state are acquired by the
  // runtime's own layers, over the spawner and database it serves.
  const layout = desktopLayout(mainDir, app.isPackaged);
  const resourcesPath = yield* checkResourcesPath(layout.resourcesPath).pipe(
    Effect.provide(nodeFileServices),
  );
  // The one Effect runtime of this process, over the stores it
  // serves: every project's session graph and Promise-facing fiber runs on
  // it, and the entry disposes it last (`disposeEffect`), after the
  // runs finish and the projects' release of their graphs.
  const runtime = withForkFailureReporting(
    ManagedRuntime.make(
      texraProcessLayer({
        name: 'desktop',
        storageRoot: dataRoot,
        resourcesPath,
        usageLog: {
          version: app.getVersion(),
          editorType: 'desktop',
        },
        // The rotated log file is the artefact attached to a bug report, so it
        // keeps debug entries; rotation already bounds its size.
        minimumLogLevel: 'Debug',
      }),
    ),
  );

  // The fallback project's scope, holding its state and its eventual session.
  const processScope = Scope.makeUnsafe();
  // The rest of the platform, read from the runtime's services: the entry runs
  // it first in its startup program, so that program's one failure path (the
  // lifecycle's shutdown, which closes `processScope`) covers it too.
  const initialize: Effect.Effect<
    ElectronPlatformInitResult,
    Error,
    ProcessServices
  > = Effect.gen(function* () {
    // A Dock- or Finder-launched app inherits a minimal environment, so it
    // reads the user's login shell first, before any command runs. Windows
    // hands a GUI app the user's environment and has no login shell.
    if (process.platform !== 'win32') {
      yield* adoptLoginShellEnvironment().pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `${error.message}; commands run with the PATH the app was started with, plus TeXRA's own tool directories`,
          ).pipe(withLogChannel('desktop')),
        ),
      );
    }
    // The process roots are the no-workspace roots. Each open project gets
    // its own roots (desktopProjects.ts); these only back the window before
    // a folder is open.
    const global = yield* openTexraGlobalConfigStore(
      TEXRA_SETTINGS.catalog,
      dataRoot,
    );
    const { roots: processRoots, warnings } = yield* openProjectRoots(
      dataRoot,
      undefined,
      global.store,
      undefined,
    ).pipe(Scope.provide(processScope));
    yield* Effect.forEach(
      [...global.warnings, ...warnings],
      (message) => Effect.logWarning(message).pipe(withLogChannel('desktop')),
      { discard: true },
    );
    return {
      processRoots,
      globalConfigStore: global.store,
      dataRoot,
      layout,
    };
  });
  return { runtime, processScope, initialize };
});
