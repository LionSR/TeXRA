import { join } from 'node:path';

import { app } from 'electron';

import { JsonConfigProvider } from '@platform/defaults/jsonConfigProvider';
import { JsonStore } from '@platform/defaults/jsonStore';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { NO_TOOL_AVAILABILITY_HOST } from '@platform/interfaces/toolAvailability';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { initPlatform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces/lifecycle';
import { StreamSnapshotStore } from '@transcript';
import { registerAgentFeatures } from '@agent/features';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '@desktop/workspacePath.js';
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

import { bootstrapElectronAgentDirectories } from './agentDirectories.js';
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import { resolveResourcesPath, resolveWorkspacePath } from './paths.js';
import { showSecretStorageWarningDialog } from './secretStorageWarningDialog.js';
import { tryResumeDesktopStream } from '../desktopAgentResume.js';

// Type imports - platform
import type { LifecycleHost } from '@platform/interfaces/lifecycle';

export interface ElectronPlatformInitResult {
  workspacePath: string | undefined;
  lifecycle: LifecycleHost;
  progressSnapshotStore: StreamSnapshotStore;
}

const WORKSPACE_CONFIG_MIGRATED_KEY = 'desktop.workspaceConfigMigratedToProject';

/**
 * One-time copy of workspace config from the pre-project-file internal store
 * (`<workspace-storage>/config.json`) into the project's `.texra/config.json`.
 * Existing project values win — a checked-in config is never overwritten.
 */
async function migrateLegacyWorkspaceConfig(init: {
  legacyPath: string;
  projectStore: JsonStore;
  workspaceState: JsonStore;
}): Promise<void> {
  if (init.workspaceState.get<boolean>(WORKSPACE_CONFIG_MIGRATED_KEY) === true) {
    return;
  }
  const legacyStore = await JsonStore.open(init.legacyPath);
  for (const [key, value] of Object.entries(legacyStore.snapshot())) {
    if (!init.projectStore.has(key)) {
      await init.projectStore.set(key, value);
    }
  }
  await init.workspaceState.update(WORKSPACE_CONFIG_MIGRATED_KEY, true);
}

export async function initializeElectronPlatform(
  mainDirname: string,
): Promise<ElectronPlatformInitResult> {
  // console.error is mirrored into the desktop app log; wording matches the
  // extension and CLI hosts so support logs read the same everywhere.
  const lifecycle = createLifecycleHost({
    onError: (phase, error) =>
      console.error(`[lifecycle] Lifecycle ${phase} handler failed:`, error),
  });
  const userDataPath = app.getPath('userData');
  const globalStateStore = await JsonStore.open(
    join(userDataPath, 'state', 'global.json'),
  );
  const workspacePath = resolveWorkspacePath({
    storedWorkspacePath: globalStateStore.get<string>(
      DESKTOP_WORKSPACE_PATH_STATE_KEY,
    ),
  });
  const storage = new WorkspaceStorageProvider(userDataPath, workspacePath);
  const workspaceStateStore = await JsonStore.open(
    join(storage.getStoragePath(), 'state.json'),
  );
  const globalConfigStore = await JsonStore.open(
    join(userDataPath, 'config', 'global.json'),
  );
  // Workspace config lives in the project's `.texra/config.json` — the same
  // file the CLI reads and writes — so a checked-in config behaves
  // identically in both hosts. Sessions without a workspace fall back to the
  // internal per-workspace store.
  const legacyWorkspaceConfigPath = join(storage.getStoragePath(), 'config.json');
  const workspaceConfigStore = await JsonStore.open(
    workspacePath
      ? workspaceTexraConfigPath(workspacePath)
      : legacyWorkspaceConfigPath,
  );
  if (workspacePath) {
    await migrateLegacyWorkspaceConfig({
      legacyPath: legacyWorkspaceConfigPath,
      projectStore: workspaceConfigStore,
      workspaceState: workspaceStateStore,
    });
  }
  const secretsStore = await JsonStore.open(join(userDataPath, 'secrets.json'));

  repairLaunchPath();
  initPlatform({
    config: new JsonConfigProvider({
      workspace: workspaceConfigStore,
      global: globalConfigStore,
    }),
    globalState: globalStateStore,
    workspaceState: workspaceStateStore,
    fs: nodeFilesystem,
    workspace: createNodeWorkspace(() => workspacePath),
    storage,
    secrets: new ElectronSecrets(secretsStore, {
      showWarningMessage: showSecretStorageWarningDialog,
    }),
    lifecycle,
    agentResume: { tryResumeStream: tryResumeDesktopStream },
    toolAvailability: NO_TOOL_AVAILABILITY_HOST,
  });
  registerAgentFeatures();

  // Persist per-stream sidecar data (todos, plan, usage, output files) via the
  // shared, host-agnostic snapshot store. The desktop progress backend owns the
  // bus event handling; the platform owns lifecycle flushing so app shutdown
  // drains the same writer instead of creating a second bus subscriber.
  const snapshotStore = new StreamSnapshotStore();
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => snapshotStore.flush());

  // Lean tools talk to `lake env lean --server` directly in the desktop build.
  registerDirectLeanLanguageServices(lifecycle);

  await bootstrapElectronAgentDirectories(
    resolveResourcesPath(mainDirname),
    app.getVersion(),
  );

  return { workspacePath, lifecycle, progressSnapshotStore: snapshotStore };
}
