import { join } from 'node:path';

import { app } from 'electron';

import { registerAgentFeatures } from '@agent/features';
import { consoleLog } from '@platform/defaults/consoleLog';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { createWorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { initPlatform } from '@platform/platform';

import { bootstrapElectronAgentDirectories } from './agentDirectories.js';
import { ElectronConfigProvider } from './electronConfig.js';
import { ElectronSecrets } from './electronSecrets.js';
import { ElectronStateStore } from './electronState.js';
import { JsonStore } from './jsonStore.js';
import { repairLaunchPath } from './pathFix.js';
import { resolveResourcesPath, resolveWorkspacePath } from './paths.js';
import { showSecretStorageWarningDialog } from './secretStorageWarningDialog.js';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '../../workspacePath.js';

// Type imports - platform
import type { LifecycleHost } from '@platform/interfaces/lifecycle';

export interface ElectronPlatformInitResult {
  workspacePath: string | undefined;
  lifecycle: LifecycleHost;
}

export async function initializeElectronPlatform(
  mainDirname: string,
): Promise<ElectronPlatformInitResult> {
  const lifecycle = createLifecycleHost();
  const userDataPath = app.getPath('userData');
  const globalStateStore = await JsonStore.open(
    join(userDataPath, 'state', 'global.json'),
  );
  const workspacePath = resolveWorkspacePath({
    storedWorkspacePath: globalStateStore.get<string>(
      DESKTOP_WORKSPACE_PATH_STATE_KEY,
    ),
  });
  const storage = createWorkspaceStorageProvider(userDataPath, workspacePath);
  const workspaceStateStore = await JsonStore.open(
    join(storage.getStoragePath(), 'state.json'),
  );
  const globalConfigStore = await JsonStore.open(
    join(userDataPath, 'config', 'global.json'),
  );
  const workspaceConfigStore = await JsonStore.open(
    join(storage.getStoragePath(), 'config.json'),
  );
  const secretsStore = await JsonStore.open(join(userDataPath, 'secrets.json'));

  repairLaunchPath();
  initPlatform({
    config: new ElectronConfigProvider(globalConfigStore, workspaceConfigStore),
    globalState: new ElectronStateStore(globalStateStore),
    workspaceState: new ElectronStateStore(workspaceStateStore),
    log: consoleLog,
    fs: nodeFilesystem,
    workspace: createNodeWorkspace(() => workspacePath),
    storage,
    secrets: new ElectronSecrets(secretsStore, {
      showWarningMessage: showSecretStorageWarningDialog,
    }),
    lifecycle,
  });
  registerAgentFeatures();

  await bootstrapElectronAgentDirectories(
    resolveResourcesPath(mainDirname),
    app.getVersion(),
  );

  return { workspacePath, lifecycle };
}
