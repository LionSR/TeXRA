import { join } from 'node:path';
import { app } from 'electron';
import { Effect } from 'effect';

import { createPlatformAgentDirectories } from '@agent/index';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { openAppStateStore } from '@controllers/session/appStateStore';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { NotificationFailed } from '@hosts/uiHosts';
import { initPlatform } from '@platform/platform';
import type { ProcessRuntime } from '@platform/processRuntime';
import {
  initProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import type {
  AgentDirectoriesPort,
  AgentResumePort,
  LifecycleHost,
  StateStore,
} from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { ConfigStore } from '@platform/defaults/jsonConfigProvider';
import { JsonStore, nodeFileServices } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { installLongRunningModelDispatcher } from '@platform/defaults/longRunningModelTransport';
import {
  nodeProcesses,
  processOwnerId,
} from '@platform/defaults/nodeProcesses';
import {
  createNodePlatform,
  createNodeWorkspaceRoots,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import {
  WorkspaceStorageProvider,
  resolveGlobalStoragePath,
} from '@platform/defaults/workspaceStorage';
import type { OwnerId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { initProcessSettingHost } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  createDesktopSetupAuth,
  type DesktopSetupAuth,
} from '../desktopSetupAuth.js';
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import { resolveDesktopDataRoot, resolveResourcesPath } from './paths.js';
import { showDesktopWarningDialog } from './warningDialog.js';
export interface ElectronPlatformInitResult {
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
  lifecycle: LifecycleHost;
  /**
   * The process-wide services the composition root builds and `initPlatform`
   * publishes. Returned so the window and the IPC surfaces below it are
   * *handed* their stores instead of each re-reading the ambient
   * `platform()` singleton: one owner, one place to substitute in a test.
   */
  globalState: StateStore;
  ownerId: OwnerId;
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
   * that need a specific bundled asset (e.g. the chat-export templates) don't
   * each re-resolve it.
   */
  resourcesPath: string;
  /**
   * The one Effect runtime of this process, built here. Returned so the entry
   * and everything it wires take it as a parameter instead of reading the
   * process-global locator.
   */
  runtime: ProcessRuntime;
  /**
   * The setup sign-in registration installed with the runtime. Each window
   * registers its own sign-in flow here, since the flow needs the window to
   * anchor its dialogs to and no window exists at install time.
   */
  setupAuth: DesktopSetupAuth;
}

export async function initializeElectronPlatform(
  mainDirname: string,
  agentResume: AgentResumePort,
): Promise<ElectronPlatformInitResult> {
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
  const storage = new WorkspaceStorageProvider(dataRoot, undefined);
  // The process identity is read before the runtime is installed: an opener
  // that uses the synchronous `open` would otherwise face an asynchronous
  // layer build.
  const processStart = await nodeProcesses.selfIdentity();
  installLongRunningModelDispatcher();
  // The stores this root serves as `Secrets` and `AppState` open before the
  // runtime that serves them, so both are threaded in as values rather than
  // resolved per call. Opening needs the filesystem and nothing else —
  // `openAppStateStore` provides its own database layer, and the JSON stores
  // want only `FileSystem`/`Path` — so it runs here, on a bootstrap fiber,
  // instead of on the runtime this function has yet to build. Nothing in the
  // open path logs or traces through Effect (the session database's one
  // warning goes through the host's own logger), so running it off the
  // process runtime's diagnostics layer changes no output.
  const { globalStateStore, workspaceStateStore, configStores, secretsStore } =
    await Effect.runPromise(
      Effect.gen(function* () {
        const [globalState, workspaceState, config, secrets] =
          yield* Effect.all(
            [
              // Global state stays in the Electron profile, beside this
              // profile's update-check records and apart from the shared
              // `~/.texra` root the workspace scopes use.
              openAppStateStore(resolveGlobalStoragePath(userDataPath)),
              openAppStateStore(storage.getStoragePath()),
              openTexraConfigStores(storage, undefined, (message) =>
                console.warn(`[desktop] ${message}`),
              ),
              JsonStore.open(join(userDataPath, 'secrets.json')),
            ],
            { concurrency: 'unbounded' },
          );
        return {
          globalStateStore: globalState,
          workspaceStateStore: workspaceState,
          configStores: config,
          secretsStore: secrets,
        };
      }).pipe(Effect.provide(nodeFileServices)),
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
  // The one Effect runtime of this process (PRD 7.7), over the stores it
  // serves: every project's session graph and Promise-facing fiber runs on
  // it, and the entry disposes it last (`disposeProcessRuntime`), after run
  // settlement and the projects' release of their graphs.
  const setupAuth = createDesktopSetupAuth();
  const runtime = installProcessRuntime({
    processStart,
    globalStorage: () => storage.getGlobalStoragePath(),
    updateCheckStorage: () => resolveGlobalStoragePath(userDataPath),
    secrets,
    appState: globalStateStore,
    setup: setupAuth.platform,
    lean: directLeanLanguageServices(),
  });

  repairLaunchPath();
  const resourcesPath = resolveResourcesPath(mainDirname);
  const agentDirectories = createPlatformAgentDirectories({
    channel: 'desktop',
    // Built-in agents are read straight out of the packaged app bundle;
    // `resolveResourcesPath` has already asserted both directories exist.
    resourcesPath,
    customDirectoryStore: {
      get: () => globalStateStore.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
    },
  });
  initPlatform(
    createNodePlatform({
      lifecycle,
      agentResume,
      agentDirectories,
    }),
  );
  const processRoots = createNodeWorkspaceRoots({
    workspacePath: undefined,
    storage: storage.getStoragePath(),
    globalStorage: storage.getGlobalStoragePath(),
    config: configStores,
    workspaceState: workspaceStateStore,
    globalState: globalStateStore,
  });
  initProcessWorkspaceRoots(processRoots);
  initProcessSettingHost('desktop');
  // TeXRA's account plane (ChatGPT / Grok sign-in). Without this
  // the model layer is bring-your-own-key. See installTexraAccountProbes.
  installTexraAccountProbes(secrets);

  // Route desktop model traffic to the same Supabase usage log the extension
  // and CLI write to, tagged with editorType 'desktop' and the app version.
  // Without this call the 30 s flush cadence never starts and every entry
  // carries an undefined host/version, so a queue shorter than one batch is
  // lost at quit — including plan accounting. `dispose()` drains it, from the
  // same BEFORE phase the other two hosts use.
  await runtime.runPromise(
    UsageLogService.initialize(runtime.scope, {}, app.getVersion(), 'desktop'),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    runtime.runPromise(UsageLogService.dispose()),
  );

  // Seed first-install defaults (e.g. disabled tools). No-ops once
  // DISABLED_TOOLS exists, so upgrading users keep the tools they enabled.
  await runtime.runPromise(seedDisabledToolDefaults(globalStateStore));

  // Project skills follow each project's session; only the bundle is fixed.
  initializeNodeRuntimeSkills({ resourcesPath });

  return {
    processRoots,
    globalConfigStore: configStores.global,
    lifecycle,
    globalState: globalStateStore,
    ownerId: processOwnerId(processStart),
    secrets,
    agentDirectories,
    dataRoot,
    resourcesPath,
    runtime,
    setupAuth,
  };
}
