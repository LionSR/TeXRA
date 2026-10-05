import { app } from 'electron';
import { Effect, Layer, Scope } from 'effect';

import { AgentDirectories, AppState } from '@texra-ai/harness';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@texra-ai/harness';
import { createNodeWorkspaceRoots } from '@texra-ai/harness/node';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@texra-ai/harness/node';
import { AgentDirectoryService } from '@agent/index';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import {
  appStateStoreFromDatabase,
  openProjectStateStore,
  openRepoStateStore,
} from '@controllers/session/appStateStore';
import { emitAppSignal } from '@eventBus/AppSignals';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { FileSecrets, secretsDirectory } from '@platform/defaults/fileSecrets';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import type { ConfigStore } from '@platform/defaults/jsonConfigProvider';
import type { ProcessServices } from '@platform/processRuntime';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import { GlobalDatabase } from '@shared/session/database';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { TEXRA_SETTING_ROWS } from '@texra/shared/settingsView/texraSettings';
import { bootstrapHost } from '@texra/controllers/hostBootstrap';
import { texraPlugins } from '@texra/tools/registry';
import { USER_MCP_CONFIG_PATH } from '@tools/mcp/mcpConfig';
import { processEnvConfigLayer } from '@utils/system/envFlags';

// Local file imports
import { repairLaunchPath } from './pathFix.js';
import {
  resolveDesktopDataRoot,
  resolveDesktopMainDir,
  resolveResourcesPath,
} from './paths.js';
import type { PlatformSecrets } from '@texra-ai/harness';
import type { AgentDirectoriesPort, StateStore } from '@texra-ai/harness';
import type { WorkspaceRoots } from '@texra-ai/harness';
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
   * The process-wide services the composition root builds. Returned so the
   * window and the IPC surfaces below it are *handed* their stores instead
   * of each re-reading them: one owner, one place to substitute in a test.
   */
  globalState: StateStore;
  secrets: PlatformSecrets;
  agentDirectories: AgentDirectoriesPort;
  /**
   * Desktop's memory/history/executions data root (`~/.texra` in
   * production, see `resolveDesktopDataRoot()`). Threaded out so the project
   * registry gets it from one owner instead of re-resolving it — this root no
   * longer lives under `userData` (#7987).
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
  const userDataPath = app.getPath('userData');
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` scheme in production so a workspace worked on from both hosts
  // shows one history.
  const dataRoot = yield* resolveDesktopDataRoot(userDataPath).pipe(
    Effect.provide(processEnvConfigLayer),
  );
  // The process roots are the no-workspace roots. Each open project gets its
  // own roots (desktopProjects.ts); this pair only backs the window before a
  // folder is open.
  const storage = resolveWorkspaceStoragePath(dataRoot, undefined);
  const globalStorage = resolveGlobalStoragePath(dataRoot);
  // Secrets precede the runtime; the process identity and application state
  // are acquired by its own layers, over the spawner and database it serves.
  const { mainDir, resourcesPath, configStores, secrets } = yield* Effect.gen(
    function* () {
      const mainDir = yield* resolveDesktopMainDir(moduleDirname);
      const resourcesPath = yield* resolveResourcesPath(mainDir);
      const configStores = yield* openTexraConfigStores(
        dataRoot,
        undefined,
        (message) => console.warn(`[desktop] ${message}`),
      );
      // The one credential store every host shares (`~/.texra/secrets/`):
      // the background service reads the keys this window saves.
      const secrets = new FileSecrets(secretsDirectory(dataRoot), (key) =>
        emitAppSignal('credentialChanged', { key }),
      );
      return { mainDir, resourcesPath, configStores, secrets };
    },
  ).pipe(Effect.provide(Layer.merge(nodeFileServices, processEnvConfigLayer)));
  // The one Effect runtime of this process (PRD 7.7), over the stores it
  // serves: every project's session graph and Promise-facing fiber runs on
  // it, and the entry disposes it last (`disposeProcessRuntime`), after run
  // settlement and the projects' release of their graphs.
  const agentDirectoriesLayer = Layer.effect(
    AgentDirectories,
    Effect.map(
      AppState,
      (state) =>
        new AgentDirectoryService({
          channel: 'desktop',
          resourcesPath,
          state,
        }),
    ),
  );
  const runtime = installProcessRuntime({
    processStart: nodeProcesses.selfIdentity(),
    globalStorage,
    plugins: texraPlugins(),
    settings: TEXRA_SETTING_ROWS,
    mcpConfigPath: USER_MCP_CONFIG_PATH,
    secrets,
    // Application state is the one the CLI and the extension keep, in the
    // shared global database: one install record for plugins and the trust
    // given to them, and one set of tool switches, across the three hosts.
    appState: Layer.effect(
      AppState,
      Effect.map(GlobalDatabase, (database) =>
        appStateStoreFromDatabase(globalStorage, database.values),
      ),
    ),
    // No editor in this process.
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    agentDirectories: agentDirectoriesLayer,
    // Desktop model traffic goes to the same anonymous usage log the extension
    // and CLI write to, tagged with editorType 'desktop' and the app version.
    // The runtime's disposal drains the queue, so a queue shorter than one
    // batch is not lost at quit.
    usageLog: usageLogLayer({
      version: app.getVersion(),
      editorType: 'desktop',
    }),
    // The process's one handle on that same global root, which the desktop's
    // remembered projects and its update check read through.
    globalDatabase: globalDatabaseLayer(globalStorage),
    // The rotated log file is the artefact attached to a bug report, so it
    // keeps debug entries; rotation already bounds its size.
    minimumLogLevel: 'Debug',
  });

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
    const globalStateStore = yield* AppState;
    const agentDirectories = yield* AgentDirectories;
    const workspaceStateStore = yield* openProjectStateStore(
      storage,
      undefined,
    ).pipe(Scope.provide(processScope));
    // Keys another window or the service writes reach this one's surfaces.
    yield* Effect.forkIn(secrets.watch(), processScope);
    repairLaunchPath();
    const processRoots = createNodeWorkspaceRoots({
      host: 'desktop',
      workspacePath: undefined,
      storage,
      globalStorage,
      config: configStores,
      workspaceState: workspaceStateStore,
      repoState: yield* openRepoStateStore(undefined, storage),
      globalState: globalStateStore,
    });
    yield* bootstrapHost({
      roots: processRoots,
      skills: { resourcesPath },
    });
    return {
      processRoots,
      globalConfigStore: configStores.global,
      globalState: globalStateStore,
      secrets,
      agentDirectories,
      dataRoot,
      resourcesPath,
      mainDir,
    };
  });
  return { runtime, processScope, initialize };
});
