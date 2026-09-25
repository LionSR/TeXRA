import { join } from 'node:path';
import { app } from 'electron';
import { Effect, Layer, Scope } from 'effect';

import { AgentDirectoryService } from '@agent/index';
import { createSupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import { bootstrapHost } from '@controllers/hostBootstrap';
import {
  openAppStateStore,
  openProjectStateStore,
} from '@controllers/session/appStateStore';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { NotificationFailed } from '@hosts/uiHosts';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  LifecycleHost,
  StateStore,
} from '@platform/interfaces';
import { AgentDirectories, AppState } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { ConfigStore } from '@platform/defaults/jsonConfigProvider';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { processEnvConfigLayer } from '@utils/system/envFlags';

// Local file imports
import {
  createDesktopSetupAuth,
  type DesktopSetupAuth,
} from '../desktopSetupAuth.js';
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import {
  resolveDesktopDataRoot,
  resolveDesktopMainDir,
  resolveResourcesPath,
} from './paths.js';
import { showDesktopWarningDialog } from './warningDialog.js';
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
  /** The account plane served as `SupabaseAuth`, built beside `secrets`. */
  supabaseAuth: SupabaseAuthShape;
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
  /**
   * The setup sign-in registration installed with the runtime. Each window
   * registers its own sign-in flow here, since the flow needs the window to
   * anchor its dialogs to and no window exists at install time.
   */
  setupAuth: DesktopSetupAuth;
}

export const initializeElectronPlatform = Effect.fn(
  'initializeElectronPlatform',
)(function* (moduleDirname: string, agentResume: AgentResumePort) {
  // The default handler's console.error is mirrored into the desktop app log,
  // so shutdown-handler failures land at error severity like the other hosts.
  const lifecycle = createLifecycleHost();
  const userDataPath = app.getPath('userData');
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` scheme in production so a workspace worked on from both hosts
  // shows one history.
  const dataRoot = resolveDesktopDataRoot(userDataPath);
  // The process roots are the no-workspace roots. Each open project gets its
  // own roots (desktopProjects.ts); this pair only backs the window before a
  // folder is open.
  const storage = resolveWorkspaceStoragePath(dataRoot, undefined);
  const globalStorage = resolveGlobalStoragePath(dataRoot);
  // Secrets precede the runtime; the process identity and application state
  // are acquired by its own layers, over the spawner and database it serves.
  const { mainDir, resourcesPath, configStores, secrets, supabaseAuth } =
    yield* Effect.gen(function* () {
      const mainDir = yield* resolveDesktopMainDir(moduleDirname);
      const resourcesPath = yield* resolveResourcesPath(mainDir);
      const [configStores, secretsStore] = yield* Effect.all(
        [
          openTexraConfigStores(dataRoot, undefined, (message) =>
            console.warn(`[desktop] ${message}`),
          ),
          JsonStore.open(join(userDataPath, 'secrets.json')),
        ],
        { concurrency: 'unbounded' },
      );
      const secrets = new ElectronSecrets(secretsStore, {
        showWarningMessage: (message) =>
          Effect.tryPromise({
            try: () => showDesktopWarningDialog(message),
            catch: (cause) =>
              new NotificationFailed({
                member: 'showWarningMessage',
                message: toErrorMessage(cause),
                cause,
              }),
          }),
      });
      const supabaseAuth = yield* createSupabaseAuth({ secrets });
      return { mainDir, resourcesPath, configStores, secrets, supabaseAuth };
    }).pipe(
      Effect.provide(Layer.merge(nodeFileServices, processEnvConfigLayer)),
    );
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
          customDirectoryStore: {
            get: () =>
              state.get<string | undefined>(GlobalStateKey.CUSTOM_AGENT_DIR),
          },
        }),
    ),
  );
  const setupAuth = createDesktopSetupAuth();
  const runtime = installProcessRuntime({
    processStart: nodeProcesses.selfIdentity(),
    globalStorage,
    secrets,
    // Electron profile state intentionally differs from the shared global DB.
    appState: Layer.effect(
      AppState,
      openAppStateStore(resolveGlobalStoragePath(userDataPath)),
    ),
    auth: supabaseAuth,
    // No editor in this process.
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    agentResume,
    agentDirectories: agentDirectoriesLayer,
    lifecycle,
    setup: setupAuth.platform,
    // Desktop model traffic goes to the same Supabase usage log the extension
    // and CLI write to, tagged with editorType 'desktop' and the app version.
    // The runtime's disposal drains the queue, so a queue shorter than one
    // batch is not lost at quit -- plan accounting included.
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
    const workspaceStateStore = yield* openProjectStateStore(storage).pipe(
      Scope.provide(processScope),
    );
    repairLaunchPath();
    const processRoots = createNodeWorkspaceRoots({
      workspacePath: undefined,
      storage,
      globalStorage,
      config: configStores,
      workspaceState: workspaceStateStore,
      globalState: globalStateStore,
    });
    yield* bootstrapHost({
      host: 'desktop',
      roots: processRoots,
      secrets,
      skills: { resourcesPath },
    });
    return {
      processRoots,
      globalConfigStore: configStores.global,
      globalState: globalStateStore,
      secrets,
      supabaseAuth,
      agentDirectories,
      dataRoot,
      resourcesPath,
      mainDir,
      setupAuth,
    };
  });
  return { lifecycle, runtime, processScope, initialize };
});
