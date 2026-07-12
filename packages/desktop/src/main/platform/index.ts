import { join } from 'node:path';

import { app } from 'electron';

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
import { initPlatform } from '@platform/platform';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { StreamSnapshotStore } from '@transcript';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '@desktop/workspacePath.js';
import { configKeyVariants } from '@shared/config/configKeys';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { migrateLegacyDesktopDataRoot } from './dataRootMigration.js';
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import {
  resolveDesktopDataRoot,
  resolveResourcesPath,
  resolveWorkspacePath,
} from './paths.js';
import { showSecretStorageWarningDialog } from './secretStorageWarningDialog.js';
import {
  isDesktopResumeInFlight,
  tryResumeDesktopStream,
} from '../desktopAgentResume.js';

// Type imports - platform
import type { LifecycleHost } from '@platform/interfaces';

export interface ElectronPlatformInitResult {
  workspacePath: string | undefined;
  lifecycle: LifecycleHost;
  progressSnapshotStore: StreamSnapshotStore;
  /**
   * Desktop's memory/history/executions data root (`~/.texra` in
   * production, see `resolveDesktopDataRoot()`). Threaded out so crash
   * reporting can scrub it from event payloads the same way it already
   * scrubs `userData` — this root no longer lives under `userData` (#7987).
   */
  dataRoot: string;
  /**
   * Whether TeXRA had run on this machine before this session, captured from
   * `LAST_KNOWN_VERSION` BEFORE the bundled-agent directory sync writes that
   * key during this same init. Threaded out so the onboarding backfill can
   * tell a returning user (veteran) from a fresh install; reading the key
   * after init would always see the just-written version and misclassify a
   * brand-new credentialed user as a veteran (→ State 2 'done', so the setup
   * card never shows). Mirrors the extension's read-before-write ordering
   * (`extension.ts` LAST_KNOWN_VERSION comment).
   */
  hasPriorInstall: boolean;
  /**
   * Resolved `packages/extension/resources` tree (bundled verbatim as
   * `extraResources` — see `electron-builder.yml`). Threaded out so callers
   * that need a specific bundled asset (e.g. the chat-export templates) don't
   * each re-resolve it.
   */
  resourcesPath: string;
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
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` scheme in production so a workspace worked on from both hosts
  // shows one history (#7987). A best-effort, one-time move of any legacy
  // `userData`-rooted store protects the maintainer's own dev machines; there
  // is no ongoing read fallback afterward — only `dataRoot` is ever read.
  const dataRoot = resolveDesktopDataRoot(userDataPath);
  await migrateLegacyDesktopDataRoot(userDataPath, dataRoot);
  const storage = new WorkspaceStorageProvider(dataRoot, workspacePath);
  const workspaceStateStore = await JsonStore.open(
    join(storage.getStoragePath(), 'state.json'),
  );
  const globalConfigStore = await JsonStore.open(
    join(userDataPath, 'config', 'global.json'),
  );
  // Workspace config lives in the project's `.texra/config.json` — the same
  // file the CLI reads and writes — so a checked-in config behaves
  // identically in both hosts. Sessions without a workspace, and project
  // trees where the file exists but cannot be read, fall back to the
  // internal per-workspace store so startup never fails on config. Opening
  // never creates `.texra/` (`JsonStore` only prepares the directory on
  // write), so a read-only tree opens fine and individual writes fail at
  // write time instead.
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
        showWarningMessage: showSecretStorageWarningDialog,
      }),
      lifecycle,
      agentResume: {
        tryResumeStream: tryResumeDesktopStream,
        isResumeInFlight: isDesktopResumeInFlight,
      },
      agentDirectories,
      getWorkspacePath: () => workspacePath,
    }),
  );

  // Capture the prior-install signal BEFORE bootstrapNodeAgentDirectories
  // (below) writes LAST_KNOWN_VERSION via the bundled-agent directory sync.
  // Reading it afterwards would always be defined, so a fresh install with a
  // credential would be misread as a returning veteran. See ElectronPlatformInitResult.
  const hasPriorInstall =
    globalStateStore.get<string | undefined>(
      GlobalStateKey.LAST_KNOWN_VERSION,
    ) !== undefined;

  const resourcesPath = resolveResourcesPath(mainDirname);

  // Persist per-stream sidecar data (todos, plan, usage, output files) via the
  // shared, host-agnostic snapshot store. The desktop progress backend owns the
  // bus event handling; the platform owns lifecycle flushing so app shutdown
  // drains the same writer instead of creating a second bus subscriber.
  const snapshotStore = new StreamSnapshotStore();
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () => snapshotStore.flush());

  // Register the shared Node-host agent runtime: memory + goal tool injections
  // and the direct Lean language services (lake env lean --server). Registered
  // after the snapshot-store shutdown handler so the snapshot flush still runs
  // before the Lean adapter dispose.
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
    progressSnapshotStore: snapshotStore,
    dataRoot,
    hasPriorInstall,
    resourcesPath,
  };
}
