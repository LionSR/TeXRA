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
import { initializeGoalPrompts } from '@agent/goal';
import { toErrorMessage } from '@common/errors';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '@desktop/workspacePath.js';
import { configKeyVariants } from '@shared/config/configKeys';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { registerDirectLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

import { bootstrapElectronAgentDirectories } from './agentDirectories.js';
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import { resolveResourcesPath, resolveWorkspacePath } from './paths.js';
import { showSecretStorageWarningDialog } from './secretStorageWarningDialog.js';
import {
  isDesktopResumeInFlight,
  tryResumeDesktopStream,
} from '../desktopAgentResume.js';

// Type imports - platform
import type { LifecycleHost } from '@platform/interfaces/lifecycle';

export interface ElectronPlatformInitResult {
  workspacePath: string | undefined;
  lifecycle: LifecycleHost;
  progressSnapshotStore: StreamSnapshotStore;
  /**
   * Whether TeXRA had run on this machine before this session, captured from
   * `LAST_KNOWN_VERSION` BEFORE the bundled-agent directory sync writes that
   * key during this same init. Threaded out so the onboarding backfill can
   * tell a returning user (veteran) from a fresh install — reading the key
   * after init would always see the just-written version and misclassify a
   * brand-new credentialed user as a veteran (→ State 2 'done', so the setup
   * card never shows). Mirrors the extension's read-before-write ordering
   * (`extension.ts` LAST_KNOWN_VERSION comment).
   */
  hasPriorInstall: boolean;
}

const WORKSPACE_CONFIG_MIGRATED_KEY =
  'desktop.workspaceConfigMigratedToProject';

export async function initializeElectronPlatform(
  mainDirname: string,
): Promise<ElectronPlatformInitResult> {
  // The default handler's console.error is mirrored into the desktop app log,
  // so shutdown-handler failures land at error severity like the other hosts.
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
  const storage = new WorkspaceStorageProvider(userDataPath, workspacePath);
  const workspaceStateStore = await JsonStore.open(
    join(storage.getStoragePath(), 'state.json'),
  );
  const globalConfigStore = await JsonStore.open(
    join(userDataPath, 'config', 'global.json'),
  );
  // Workspace config lives in the project's `.texra/config.json` — the same
  // file the CLI reads and writes — so a checked-in config behaves
  // identically in both hosts. Sessions without a workspace, and read-only
  // project trees where the file cannot be created or written, fall back to
  // the internal per-workspace store so startup never fails on config.
  const legacyWorkspaceConfigPath = join(
    storage.getStoragePath(),
    'config.json',
  );
  let projectConfigStore: JsonStore | undefined;
  if (workspacePath) {
    try {
      projectConfigStore = await JsonStore.open(
        workspaceTexraConfigPath(workspacePath),
      );
    } catch (error) {
      console.warn(
        `[desktop] Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  const workspaceConfigStore =
    projectConfigStore ?? (await JsonStore.open(legacyWorkspaceConfigPath));
  // One-time copy from the pre-project-file internal store into the project
  // file; existing project values win, so a checked-in config is never
  // overwritten. Presence is checked across key variants because checked-in
  // CLI configs use bare keys (`model`) while this store wrote canonical
  // `texra.*` keys, which shadow bare ones on read. A write failure (e.g. a
  // read-only tree) only skips the merge-only migration — the readable
  // project file stays the config source — and retries on the next launch.
  if (
    projectConfigStore &&
    workspaceStateStore.get<boolean>(WORKSPACE_CONFIG_MIGRATED_KEY) !== true
  ) {
    const projectStore = projectConfigStore;
    try {
      const legacyStore = await JsonStore.open(legacyWorkspaceConfigPath);
      for (const [key, value] of Object.entries(legacyStore.snapshot())) {
        const inProject = configKeyVariants(key).some((variant) =>
          projectStore.has(variant),
        );
        if (!inProject) {
          await projectStore.set(key, value);
        }
      }
      await workspaceStateStore.update(WORKSPACE_CONFIG_MIGRATED_KEY, true);
    } catch (error) {
      console.warn(
        `[desktop] Legacy workspace config migration failed; will retry on next launch. Cause: ${toErrorMessage(error)}`,
      );
    }
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
    agentResume: {
      tryResumeStream: tryResumeDesktopStream,
      isResumeInFlight: isDesktopResumeInFlight,
    },
    toolAvailability: NO_TOOL_AVAILABILITY_HOST,
  });
  registerAgentFeatures();

  // Capture the prior-install signal BEFORE bootstrapElectronAgentDirectories
  // (below) writes LAST_KNOWN_VERSION via the bundled-agent directory sync.
  // Reading it afterwards would always be defined, so a fresh install with a
  // credential would be misread as a returning veteran. See ElectronPlatformInitResult.
  const hasPriorInstall =
    globalStateStore.get<string | undefined>(
      GlobalStateKey.LAST_KNOWN_VERSION,
    ) !== undefined;

  const resourcesPath = resolveResourcesPath(mainDirname);
  initializeGoalPrompts(join(resourcesPath, 'goal', 'goal.yaml'));

  // Persist per-stream sidecar data (todos, plan, usage, output files) via the
  // shared, host-agnostic snapshot store. The desktop progress backend owns the
  // bus event handling; the platform owns lifecycle flushing so app shutdown
  // drains the same writer instead of creating a second bus subscriber.
  const snapshotStore = new StreamSnapshotStore();
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => snapshotStore.flush());

  // Lean tools talk to `lake env lean --server` directly in the desktop build.
  registerDirectLeanLanguageServices(lifecycle);

  await bootstrapElectronAgentDirectories(resourcesPath, app.getVersion());

  return {
    workspacePath,
    lifecycle,
    progressSnapshotStore: snapshotStore,
    hasPriorInstall,
  };
}
