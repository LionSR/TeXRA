import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { isFileNotFoundError } from '@common/errors';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '@desktop/shared/workspacePath.js';
import { initPlatform } from '@platform/platform';
import type { AgentResumePort, LifecycleHost } from '@platform/interfaces';
import { JsonStore } from '@platform/defaults/jsonStore';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import {
  bootstrapNodeAgentDirectories,
  createNodePlatform,
  initNodeAgentRuntime,
  initializeNodeGoalPrompts,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import { workspaceTexraConfigPath } from '@platform/defaults/nodeStorage';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

/**
 * Whether a write through a `JsonStore` at `filePath` could succeed:
 * `flush()` creates the containing directory on demand and then writes a
 * temp file into it, so the deepest existing ancestor of `filePath` must be
 * writable and traversable. Answers false for e.g. a read-only checkout
 * without ever creating the directory in the project tree.
 */
async function canCreateOrWrite(filePath: string): Promise<boolean> {
  let dir = dirname(filePath);
  // Walk up to the deepest existing ancestor; the workspace root exists, so
  // this terminates after a step or two.
  for (;;) {
    try {
      await access(dir, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      const parent = dirname(dir);
      if (!isFileNotFoundError(error) || parent === dir) return false;
      dir = parent;
    }
  }
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
  const workspaceStateStore = await JsonStore.open(
    join(storage.getStoragePath(), 'state.json'),
  );
  const globalConfigStore = await JsonStore.open(
    join(storage.getGlobalStoragePath(), 'config.json'),
  );
  // A workspace uses its `.texra/config.json`, shared with the CLI. Sessions
  // without a workspace, and read-only projects without an existing config,
  // use the internal workspace store so settings remain writable.
  let workspaceConfigStore: JsonStore | undefined;
  if (workspacePath) {
    const projectConfigPath = workspaceTexraConfigPath(workspacePath);
    try {
      const projectConfigStore = await JsonStore.open(projectConfigPath);
      const hasProjectConfig =
        Object.keys(projectConfigStore.snapshot()).length > 0;
      if (hasProjectConfig || (await canCreateOrWrite(projectConfigPath))) {
        workspaceConfigStore = projectConfigStore;
      }
    } catch (error) {
      console.warn(
        `[desktop] Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  workspaceConfigStore ??= await JsonStore.open(
    join(storage.getStoragePath(), 'config.json'),
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
      configStores: {
        workspace: workspaceConfigStore,
        global: globalConfigStore,
      },
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
  // TeXRA's account plane (subscription relay + ChatGPT sign-in). Without this
  // the model layer is bring-your-own-key. See installTexraModelAccess.
  installTexraModelAccess();

  // Seed first-install defaults (e.g. disabled tools) before anything writes
  // LAST_KNOWN_VERSION, so upgrading users are not affected. Mirrors the
  // extension's ordering (extension.ts) — same key, same seeding function.
  await seedDisabledToolDefaults(GlobalStateKey.LAST_KNOWN_VERSION);

  const resourcesPath = resolveResourcesPath(mainDirname);

  // Register the shared Node-host agent runtime: memory + goal tool injections
  // and the direct Lean language services (lake env lean --server).
  initNodeAgentRuntime(lifecycle);
  initializeNodeGoalPrompts(resourcesPath);
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
