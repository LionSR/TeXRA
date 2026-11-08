import { app } from 'electron';
import { Effect, ManagedRuntime, Scope } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/harness';
import {
  AppState,
  type ProcessServices,
  StateStores,
} from '@texra-ai/harness/host';
import { withForkFailureReporting } from '@texra-ai/harness/transcript';
import {
  nodeFileServices,
  openNodeWorkspaceRoots,
} from '@texra-ai/harness/node';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import { openTexraConfigStores } from '@texra/platform/defaults/nodeStores';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { texraProcessLayer } from '@texra/controllers/texraProcessLayer';

// Local file imports
import { repairLaunchPath } from './pathFix.js';
import { resolveDesktopMainDir, resolveResourcesPath } from './paths.js';
import type { ConfigStore } from '@texra-ai/harness/node';
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
  /**
   * Resolved `packages/extension/resources` tree (bundled verbatim as
   * `extraResources` — see `electron-builder.yml`). Threaded out so callers
   * that need a specific bundled asset (e.g. the trace viewer page) don't
   * each re-resolve it.
   */
  resourcesPath: string;
  /** The directory of the built main bundle, beside its preload and renderer. */
  mainDir: string;
}

export const initializeElectronPlatform = Effect.fn(
  'initializeElectronPlatform',
)(function* (moduleDirname: string) {
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` so a workspace worked on from both hosts shows one history.
  const dataRoot = defaultNodeStorageRoot();
  // The process identity and application state are acquired by the
  // runtime's own layers, over the spawner and database it serves.
  const { mainDir, resourcesPath, configStores } = yield* Effect.gen(
    function* () {
      const mainDir = yield* resolveDesktopMainDir(moduleDirname);
      const resourcesPath = yield* resolveResourcesPath(
        mainDir,
        app.isPackaged,
      );
      const configStores = yield* openTexraConfigStores(
        TEXRA_SETTINGS.catalog,
        dataRoot,
        undefined,
        (message) => console.warn(`[desktop] ${message}`),
      );
      return { mainDir, resourcesPath, configStores };
    },
  ).pipe(Effect.provide(nodeFileServices));
  // The one Effect runtime of this process, over the stores it
  // serves: every project's session graph and Promise-facing fiber runs on
  // it, and the entry disposes it last (`disposeEffect`), after run
  // settlement and the projects' release of their graphs.
  const runtime = withForkFailureReporting(
    ManagedRuntime.make(
      texraProcessLayer({
        name: 'desktop',
        inquiryPanel: true,
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
    repairLaunchPath();
    // The process roots are the no-workspace roots. Each open project gets
    // its own roots (desktopProjects.ts); these only back the window before
    // a folder is open.
    const processRoots = yield* openNodeWorkspaceRoots({
      workspaceRoot: undefined,
      storageRoot: dataRoot,
      config: configStores,
      stateStores: yield* StateStores,
      globalState: yield* AppState,
    }).pipe(Scope.provide(processScope));
    return {
      processRoots,
      globalConfigStore: configStores.global,
      dataRoot,
      resourcesPath,
      mainDir,
    };
  });
  return { runtime, processScope, initialize };
});
