import { join } from 'node:path';
import { app } from 'electron';
import { Effect } from 'effect';

import { createPlatformAgentDirectories } from '@agent/index';
import { createSupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import { bootstrapHost } from '@controllers/hostBootstrap';
import { openAppStateStore } from '@controllers/session/appStateStore';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { NotificationFailed } from '@hosts/uiHosts';
import { initPlatform } from '@platform/platform';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
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
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import { openTexraConfigStores } from '@platform/defaults/nodeStores';
import {
  WorkspaceStorageProvider,
  resolveGlobalStoragePath,
} from '@platform/defaults/workspaceStorage';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  createDesktopSetupAuth,
  type DesktopSetupAuth,
} from '../desktopSetupAuth.js';
import { createSessionLog } from '../desktopSupabaseAuth.js';
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
  // The stores this root serves as `Secrets` and `AppState` open before the
  // runtime that serves them, so both are threaded in as values rather than
  // resolved per call. Opening needs the filesystem and nothing else —
  // `openAppStateStore` provides its own database layer, and the JSON stores
  // want only `FileSystem`/`Path` — so it runs here, on a bootstrap fiber,
  // instead of on the runtime this function has yet to build. Nothing in the
  // open path logs or traces through Effect (the session database's one
  // warning goes through the host's own logger), so running it off the
  // process runtime's diagnostics layer changes no output.
  const {
    processStart,
    globalStateStore,
    workspaceStateStore,
    configStores,
    secretsStore,
  } = await Effect.runPromise(
    Effect.gen(function* () {
      // The identity resolves before the runtime is installed, on this same
      // bootstrap run: an opener that uses the synchronous `open` would
      // otherwise face an asynchronous layer build.
      const processStart = yield* nodeProcesses.selfIdentity();
      const [globalState, workspaceState, config, secrets] = yield* Effect.all(
        [
          // Global state stays in the Electron profile, apart from the
          // shared `~/.texra` root the workspace scopes and this process's
          // one global database handle -- the update check among them -- use.
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
        processStart,
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
  // The account plane is built before the runtime that serves it, beside the
  // secrets store it reads; the window's sign-in surfaces take it from the
  // init result below.
  const supabaseAuth = Effect.runSync(
    createSupabaseAuth({
      secrets,
      log: createSessionLog(console),
    }),
  );
  // The one Effect runtime of this process (PRD 7.7), over the stores it
  // serves: every project's session graph and Promise-facing fiber runs on
  // it, and the entry disposes it last (`disposeProcessRuntime`), after run
  // settlement and the projects' release of their graphs.
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
  const setupAuth = createDesktopSetupAuth();
  const runtime = installProcessRuntime({
    processStart: Effect.succeed(processStart),
    globalStorage: storage.getGlobalStoragePath(),
    secrets,
    appState: globalStateStore,
    auth: supabaseAuth,
    // No editor in this process.
    languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
    agentResume,
    agentDirectories,
    lifecycle,
    setup: setupAuth.platform,
    lean: directLeanLanguageServices(),
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
    globalDatabase: globalDatabaseLayer(storage.getGlobalStoragePath()),
    // The rotated log file is the artefact attached to a bug report, so it
    // keeps debug entries; rotation already bounds its size.
    minimumLogLevel: 'Debug',
  });

  repairLaunchPath();
  initPlatform({ lifecycle, agentDirectories });
  const processRoots = createNodeWorkspaceRoots({
    workspacePath: undefined,
    storage: storage.getStoragePath(),
    globalStorage: storage.getGlobalStoragePath(),
    config: configStores,
    workspaceState: workspaceStateStore,
    globalState: globalStateStore,
  });
  // Everything this process installs once after its platform exists, in the
  // order the shared bootstrap owns for all three hosts.
  await runtime.runPromise(
    bootstrapHost({
      host: 'desktop',
      roots: processRoots,
      secrets,
      skills: { resourcesPath },
    }),
  );

  return {
    processRoots,
    globalConfigStore: configStores.global,
    lifecycle,
    globalState: globalStateStore,
    secrets,
    supabaseAuth,
    agentDirectories,
    dataRoot,
    resourcesPath,
    runtime,
    setupAuth,
  };
}
