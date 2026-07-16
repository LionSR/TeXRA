// Node imports
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Local imports - platform
import {
  mergeLegacyStorageBucket,
  moveEntryIfAbsent,
  readLegacyDirEntries,
} from '@platform/defaults/legacyDataMigration';
import {
  LEGACY_RUNS_STORAGE_DIR,
  MEMORY_STORAGE_DIR,
  resolveWorkspaceStoragePath,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import { STREAM_LOGS_DIR } from '@transcript/StreamLogStore';
import { STREAM_DATA_DIR } from '@transcript/streamDataPaths';

// Type imports - platform
import type { LegacyDataMigrationLogger } from '@platform/defaults/legacyDataMigration';

export type DesktopDataRootMigrationLogger = LegacyDataMigrationLogger;

const GLOBAL_STORAGE_DIR = 'global-storage';
const WORKSPACE_STORAGE_DIR = 'workspace-storage';
const WORKSPACE_MERGE_PER_CHILD = [
  RUNS_STORAGE_DIR,
  LEGACY_RUNS_STORAGE_DIR,
  STREAM_DATA_DIR,
  STREAM_LOGS_DIR,
  MEMORY_STORAGE_DIR,
] as const;

function desktopPrefixed(
  logger: DesktopDataRootMigrationLogger,
): LegacyDataMigrationLogger {
  return {
    info: (message) => logger.info(`[desktop] ${message}`),
    warn: (message) => logger.warn(`[desktop] ${message}`),
  };
}

/**
 * Best-effort, one-time move of a legacy Electron `userData`-rooted storage
 * tree onto the shared `~/.texra` data root the CLI already uses (#7987).
 *
 * Desktop has never shipped a public release, so this is intentionally NOT a
 * durable read-through fallback — it exists only to protect data already
 * sitting on the maintainer's own dev machines. After this returns, only
 * `targetRoot` is ever read; there is no ongoing legacy read path.
 *
 * Each top-level storage directory and each per-workspace-key directory
 * under `workspace-storage` is moved independently so a partial legacy tree
 * migrates as much as it safely can, and an existing target directory is
 * never overwritten — it is skipped with a warning instead (mirrors the
 * #5776 config-migration pattern: log per directory, never clobber).
 *
 * Idempotent: once a legacy directory has been moved, it no longer exists,
 * so subsequent calls (e.g. on the next app launch) are cheap no-ops.
 */
export async function migrateLegacyDesktopDataRoot(
  legacyRoot: string,
  targetRoot: string,
  logger: DesktopDataRootMigrationLogger = console,
): Promise<void> {
  if (legacyRoot === targetRoot) return;
  const prefixed = desktopPrefixed(logger);

  await moveEntryIfAbsent(
    join(legacyRoot, GLOBAL_STORAGE_DIR),
    join(targetRoot, GLOBAL_STORAGE_DIR),
    GLOBAL_STORAGE_DIR,
    prefixed,
  );

  const legacyWorkspaceRoot = join(legacyRoot, WORKSPACE_STORAGE_DIR);
  if (!existsSync(legacyWorkspaceRoot)) return;

  const entries = await readLegacyDirEntries(legacyWorkspaceRoot, prefixed);
  if (!entries) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await moveEntryIfAbsent(
      join(legacyWorkspaceRoot, entry.name),
      join(targetRoot, WORKSPACE_STORAGE_DIR, entry.name),
      `${WORKSPACE_STORAGE_DIR}/${entry.name}`,
      prefixed,
    );
  }
}

/**
 * Merge a pre-canonical desktop workspace bucket into its physical-path
 * bucket. This is a one-time identity migration, not an ongoing read fallback.
 */
export async function migrateLegacyDesktopWorkspaceBucket(
  dataRoot: string,
  legacyWorkspacePath: string | undefined,
  workspacePath: string | undefined,
  logger: DesktopDataRootMigrationLogger = console,
): Promise<void> {
  if (!legacyWorkspacePath || !workspacePath) return;
  await mergeLegacyStorageBucket(
    resolveWorkspaceStoragePath(dataRoot, legacyWorkspacePath),
    resolveWorkspaceStoragePath(dataRoot, workspacePath),
    {
      mergePerChild: WORKSPACE_MERGE_PER_CHILD,
      label: 'desktop-workspace-alias',
      logger: desktopPrefixed(logger),
    },
  );
}
