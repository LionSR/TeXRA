import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergeLegacyWorkspaceStorageBucket,
  moveEntryIfAbsent,
  readLegacyDirEntries,
} from '@platform/defaults/legacyDataMigration';
import { resolveWorkspaceStoragePath } from '@platform/defaults/workspaceStorage';
import type { LegacyDataMigrationLogger } from '@platform/defaults/legacyDataMigration';
import { toErrorMessage } from '@utils/errors/errorMessage';

export type DesktopDataRootMigrationLogger = LegacyDataMigrationLogger;

const GLOBAL_STORAGE_DIR = 'global-storage';
const WORKSPACE_STORAGE_DIR = 'workspace-storage';

function desktopPrefixed(
  logger: DesktopDataRootMigrationLogger,
): LegacyDataMigrationLogger {
  return {
    info: (message) => logger.info(`[desktop] ${message}`),
    warn: (message) => logger.warn(`[desktop] ${message}`),
  };
}

/**
 * Run one best-effort legacy migration during platform init.
 *
 * The per-entry move paths below are already loud-but-non-throwing, but the
 * surrounding path resolution is not: a throw from there would abort desktop
 * startup over data that only needs moving once. Mirrors the extension's
 * per-bucket guard in `sharedStorageRoot.ts` — warn with the cause, leave the
 * legacy data in place, and let the host finish starting.
 */
export async function runBestEffortMigration(
  label: string,
  migrate: () => Promise<void>,
  logger: DesktopDataRootMigrationLogger = console,
): Promise<void> {
  try {
    await migrate();
  } catch (error) {
    desktopPrefixed(logger).warn(
      `${label} migration failed; legacy data stays in place. Cause: ${toErrorMessage(error)}`,
    );
  }
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
  await mergeLegacyWorkspaceStorageBucket(
    resolveWorkspaceStoragePath(dataRoot, legacyWorkspacePath),
    resolveWorkspaceStoragePath(dataRoot, workspacePath),
    {
      label: 'desktop-workspace-alias',
      logger: desktopPrefixed(logger),
    },
  );
}
