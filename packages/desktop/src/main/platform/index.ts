import { join } from 'node:path';
import { app } from 'electron';
import { initializeBundledPrompts } from '@agent/runtime';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '@desktop/shared/workspacePath.js';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { refreshModelListStateIfNeeded } from '@model/modelListRefresh';
import { initPlatform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import type { AgentResumePort, LifecycleHost } from '@platform/interfaces';
import { JsonStore } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { initNodeAgentRuntime } from '@platform/defaults/nodeAgentRuntime';
import {
  bootstrapNodeAgentDirectories,
  createNodePlatform,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import {
  openNodeWorkspaceStateStore,
  openTexraConfigStores,
} from '@platform/defaults/nodeStores';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';

// Local file imports
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import {
  resolveDesktopDataRoot,
  resolveResourcesPath,
  resolveWorkspacePath,
} from './paths.js';
import { showDesktopWarningDialog } from './warningDialog.js';
export interface ElectronPlatformInitResult {
  workspacePath: string | undefined;
  lifecycle: LifecycleHost;
  /**
   * Desktop's memory/history/executions data root (`~/.texra` in
   * production, see `resolveDesktopDataRoot()`). Threaded out so crash
   * reporting can scrub it from event payloads the same way it already
   * scrubs `userData` — this root no longer lives under `userData` (#7987).
   */
  dataRoot: string;
  /**
   * Resolved `packages/extension/resources` tree (bundled verbatim as
   * `extraResources` — see `electron-builder.yml`). Threaded out so callers
   * that need a specific bundled asset (e.g. the chat-export templates) don't
   * each re-resolve it.
   */
  resourcesPath: string;
}

export async function initializeElectronPlatform(
  mainDirname: string,
  agentResume: AgentResumePort,
): Promise<ElectronPlatformInitResult> {
  // The default handler's console.error is mirrored into the desktop app log,
  // so shutdown-handler failures land at error severity like the other hosts.
  const lifecycle = createLifecycleHost();
  const userDataPath = app.getPath('userData');
  const globalStateStore = await JsonStore.open(
    join(userDataPath, 'state', 'global.json'),
  );
  const storedWorkspacePath = globalStateStore.get<string>(
    DESKTOP_WORKSPACE_PATH_STATE_KEY,
  );
  const workspacePath = resolveWorkspacePath({ storedWorkspacePath });
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` scheme in production so a workspace worked on from both hosts
  // shows one history.
  const dataRoot = resolveDesktopDataRoot(userDataPath);
  const storage = new WorkspaceStorageProvider(dataRoot, workspacePath);
  const workspaceStateStore = await openNodeWorkspaceStateStore(storage);
  const configStores = await openTexraConfigStores(
    storage,
    workspacePath,
    (message) => console.warn(`[desktop] ${message}`),
  );
  const secretsStore = await JsonStore.open(join(userDataPath, 'secrets.json'));

  repairLaunchPath();
  const agentDirectories = createPlatformAgentDirectories({
    channel: 'desktop',
    customDirectoryStore: {
      get: () => globalStateStore.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
    },
  });
  initPlatform(
    createNodePlatform({
      config: configStores,
      globalState: globalStateStore,
      workspaceState: workspaceStateStore,
      storage,
      secrets: new ElectronSecrets(secretsStore, {
        showWarningMessage: showDesktopWarningDialog,
      }),
      lifecycle,
      agentResume,
      agentDirectories,
      getWorkspacePath: () => workspacePath,
    }),
  );
  // TeXRA's account plane (ChatGPT / Grok sign-in). Without this
  // the model layer is bring-your-own-key. See installTexraAccountProbes.
  installTexraAccountProbes();

  // Route desktop model traffic to the same Supabase usage log the extension
  // and CLI write to, tagged with editorType 'desktop' and the app version.
  // Without this call the 30 s flush cadence never starts and every entry
  // carries an undefined host/version, so a queue shorter than one batch is
  // lost at quit — including plan accounting. `dispose()` drains it, from the
  // same BEFORE phase the other two hosts use.
  UsageLogService.initialize({}, app.getVersion(), 'desktop');
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => UsageLogService.dispose());

  // Reconcile the persisted enabled-models list against the current curated
  // defaults, as the extension and CLI hosts do at startup. Preferred defaults
  // reconcile when MODEL_LIST_VERSION changes; retired entries and stale
  // Copilot route preferences are swept on every startup. Runs here so it is
  // upstream of the settings view's first model-list paint.
  try {
    const { added, removed, reordered, routePreferencesCleared } =
      await refreshModelListStateIfNeeded(globalStateStore);
    const changed = added.length > 0 || removed.length > 0 || reordered;
    if (changed || routePreferencesCleared.length > 0) {
      invalidateModelOptionsCache();
      if (changed) {
        console.info(
          `[desktop] Refreshed enabled models: added [${added.join(', ')}], removed [${removed.join(', ')}]${reordered ? ', reordered' : ''}`,
        );
      }
      if (routePreferencesCleared.length > 0) {
        console.info(
          `[desktop] Cleared stale Copilot route preferences: [${routePreferencesCleared.join(', ')}]`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[desktop] Failed to refresh model list: ${toErrorMessage(error)}`,
    );
  }

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected. Mirrors the
  // extension's ordering (extension.ts) — same key, same seeding function.
  await seedDisabledToolDefaults(GlobalStateKey.LAST_KNOWN_VERSION);

  const resourcesPath = resolveResourcesPath(mainDirname);

  // Register the shared Node-host agent runtime: memory + goal tool injections
  // and the direct Lean language services (lake env lean --server).
  initNodeAgentRuntime(lifecycle);
  // Goal continuation and follow-up polish read the same bundled templates as
  // the extension; one call registers every row of the prompt table, so
  // desktop cannot wire one prompt and forget another the way it once did.
  initializeBundledPrompts(resourcesPath);
  initializeNodeRuntimeSkills({
    cwd: workspacePath ?? app.getPath('home'),
    resourcesPath,
  });

  await bootstrapNodeAgentDirectories({
    channel: 'desktop',
    resourcesPath,
    currentVersion: app.getVersion(),
    versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
  });

  return {
    workspacePath,
    lifecycle,
    dataRoot,
    resourcesPath,
  };
}
