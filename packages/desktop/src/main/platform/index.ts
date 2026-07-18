import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
import { isFileNotFoundError } from '@common/errors';
import { DESKTOP_WORKSPACE_PATH_STATE_KEY } from '@desktop/workspacePath.js';
import { configKeyVariants } from '@shared/config/configKeys';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  migrateLegacyDesktopDataRoot,
  migrateLegacyDesktopWorkspaceBucket,
} from './dataRootMigration.js';
import { ElectronSecrets } from './electronSecrets.js';
import { repairLaunchPath } from './pathFix.js';
import {
  resolveDesktopDataRoot,
  resolveLegacyWorkspacePath,
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
  const workspaceOptions = { storedWorkspacePath };
  const legacyWorkspacePath = resolveLegacyWorkspacePath(workspaceOptions);
  const workspacePath = resolveWorkspacePath(workspaceOptions);
  // Desktop's memory/history/executions data root: shared with the CLI's
  // `~/.texra` scheme in production so a workspace worked on from both hosts
  // shows one history (#7987). A best-effort, one-time move of any legacy
  // `userData`-rooted store protects the maintainer's own dev machines; there
  // is no ongoing read fallback afterward — only `dataRoot` is ever read.
  const dataRoot = resolveDesktopDataRoot(userDataPath);
  await migrateLegacyDesktopDataRoot(userDataPath, dataRoot);
  await migrateLegacyDesktopWorkspaceBucket(
    dataRoot,
    legacyWorkspacePath,
    workspacePath,
  );
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
  // trees where the file cannot be read or could never be written, fall
  // back to the internal per-workspace store so startup never fails on
  // config and settings writes keep working. Opening never creates
  // `.texra/` (`JsonStore` only prepares the directory on write), so
  // whether an absent file could ever be written is probed explicitly
  // below instead of being inferred from an open failure.
  const legacyWorkspaceConfigPath = join(
    storage.getStoragePath(),
    'config.json',
  );
  let projectConfigStore: JsonStore | undefined;
  let projectConfigWritable = false;
  if (workspacePath) {
    const projectConfigPath = workspaceTexraConfigPath(workspacePath);
    try {
      projectConfigStore = await JsonStore.open(projectConfigPath);
      projectConfigWritable = await canCreateOrWrite(projectConfigPath);
    } catch (error) {
      console.warn(
        `[desktop] Cannot open project .texra/config.json; using the internal workspace config store. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  // The pre-project-file internal store is both the migration source and the
  // fallback config source; it is opened exactly once. Without a project
  // store it is the only possible source, so a failed open stays fatal here
  // (matching the previously unguarded open); with one, it is a soft
  // degradation.
  let internalConfigStore: JsonStore | undefined;
  try {
    internalConfigStore = await JsonStore.open(legacyWorkspaceConfigPath);
  } catch (error) {
    if (projectConfigStore === undefined) throw error;
    console.warn(
      `[desktop] Cannot open the internal workspace config store; the project config is the only source this session. Cause: ${toErrorMessage(error)}`,
    );
  }
  // One-time copy from the internal store into the project file; existing
  // project values win, so a checked-in config is never overwritten.
  // Presence is checked across key variants because checked-in CLI configs
  // use bare keys (`model`) while this store wrote canonical `texra.*` keys,
  // which shadow bare ones on read. A write failure (e.g. a read-only tree)
  // only skips the merge-only migration and retries on the next launch.
  const projectHadContent =
    projectConfigStore !== undefined &&
    Object.keys(projectConfigStore.snapshot()).length > 0;
  let migrationOutcome: 'not-run' | 'succeeded' | 'failed' = 'not-run';
  if (
    projectConfigStore &&
    internalConfigStore &&
    workspaceStateStore.get<boolean>(WORKSPACE_CONFIG_MIGRATED_KEY) !== true
  ) {
    const projectStore = projectConfigStore;
    try {
      for (const [key, value] of Object.entries(
        internalConfigStore.snapshot(),
      )) {
        const inProject = configKeyVariants(key).some((variant) =>
          projectStore.has(variant),
        );
        if (!inProject) {
          await projectStore.set(key, value);
        }
      }
      migrationOutcome = 'succeeded';
    } catch (error) {
      migrationOutcome = 'failed';
      console.warn(
        `[desktop] Legacy workspace config migration failed; will retry on next launch. Cause: ${toErrorMessage(error)}`,
      );
    }
  }
  // Single owner of the session's config-source decision: the project store
  // serves the session only when it opened AND either already had content (a
  // readable checked-in config is always the source), or the internal store
  // is unreadable (there is nothing it could shadow), or config can actually
  // land in the project tree (the location is writable and the migration
  // copy-in didn't fail). The writability probe stands in for the eager
  // `.texra/` creation `JsonStore.open()` performed before #8220: without
  // it, an empty project store on an unwritable tree would be adopted
  // without any throw — shadowing pre-migration settings and rejecting every
  // later settings write at `flush()` — while the internal store would have
  // kept working.
  let workspaceConfigStore: JsonStore;
  if (
    projectConfigStore !== undefined &&
    (projectHadContent ||
      internalConfigStore === undefined ||
      (migrationOutcome !== 'failed' && projectConfigWritable))
  ) {
    workspaceConfigStore = projectConfigStore;
  } else if (internalConfigStore !== undefined) {
    workspaceConfigStore = internalConfigStore;
  } else {
    // Unreachable: a failed internal open above is fatal unless a project
    // store exists, and a missing internal store selects the project branch.
    throw new Error('[desktop] No usable workspace config store');
  }
  // Latch the migrated flag only once the copied-in content actually serves
  // from the project file. Latching on a vacuous success while the internal
  // store remains the session source would permanently skip migrating any
  // settings written later (e.g. once a read-only checkout becomes
  // writable). Best-effort like the copy itself: a failed latch just re-runs
  // the idempotent merge next launch.
  if (
    workspaceConfigStore === projectConfigStore &&
    migrationOutcome === 'succeeded'
  ) {
    try {
      await workspaceStateStore.update(WORKSPACE_CONFIG_MIGRATED_KEY, true);
    } catch (error) {
      console.warn(
        `[desktop] Could not record the workspace config migration; it will re-run on next launch. Cause: ${toErrorMessage(error)}`,
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
      getLegacyWorkspacePaths: () =>
        legacyWorkspacePath && legacyWorkspacePath !== workspacePath
          ? [legacyWorkspacePath]
          : [],
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
