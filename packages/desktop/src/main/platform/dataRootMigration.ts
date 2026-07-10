// Node imports
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Local imports - utils
import { toErrorMessage } from '@utils/errors/errorMessage';

// Type imports - node
import type { Dirent } from 'node:fs';

export interface DesktopDataRootMigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

const GLOBAL_STORAGE_DIR = 'global-storage';
const WORKSPACE_STORAGE_DIR = 'workspace-storage';

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error != null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

async function moveDirectoryIfAbsent(
  legacyPath: string,
  targetPath: string,
  label: string,
  logger: DesktopDataRootMigrationLogger,
): Promise<void> {
  if (!existsSync(legacyPath)) return;
  if (existsSync(targetPath)) {
    logger.warn(
      `[desktop] Skipping legacy data migration for "${label}": a directory already exists at ${targetPath}. Legacy data is still at ${legacyPath}; move it manually if needed.`,
    );
    return;
  }
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await rename(legacyPath, targetPath);
    logger.info(`[desktop] Migrated legacy "${label}" to ${targetPath}.`);
  } catch (error) {
    // Surface the errno code (e.g. EXDEV on some Windows redirected-profile
    // setups, EACCES on permission-restricted trees, ENOSPC when the target
    // volume is full) so a failure is diagnosable from the log line alone —
    // this stays non-throwing/best-effort either way.
    const code = errorCodeOf(error);
    logger.warn(
      `[desktop] Failed to migrate legacy "${label}" to ${targetPath}${code ? ` (${code})` : ''}. Legacy data is still at ${legacyPath}. Cause: ${toErrorMessage(error)}`,
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

  await moveDirectoryIfAbsent(
    join(legacyRoot, GLOBAL_STORAGE_DIR),
    join(targetRoot, GLOBAL_STORAGE_DIR),
    GLOBAL_STORAGE_DIR,
    logger,
  );

  const legacyWorkspaceRoot = join(legacyRoot, WORKSPACE_STORAGE_DIR);
  if (!existsSync(legacyWorkspaceRoot)) return;

  // Best-effort here too: an unreadable legacy directory (EACCES, or
  // ENOTDIR if something unexpected occupies that path) must not abort
  // startup — it only means this run can't migrate workspace-storage.
  let entries: Dirent[];
  try {
    entries = await readdir(legacyWorkspaceRoot, { withFileTypes: true });
  } catch (error) {
    const code = errorCodeOf(error);
    logger.warn(
      `[desktop] Failed to read legacy workspace-storage directory ${legacyWorkspaceRoot}${code ? ` (${code})` : ''}. Cause: ${toErrorMessage(error)}`,
    );
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await moveDirectoryIfAbsent(
      join(legacyWorkspaceRoot, entry.name),
      join(targetRoot, WORKSPACE_STORAGE_DIR, entry.name),
      `${WORKSPACE_STORAGE_DIR}/${entry.name}`,
      logger,
    );
  }
}
