/**
 * Best-effort, one-time moves of legacy host storage onto the shared
 * `~/.texra` data root (#7987, #8622).
 *
 * Used by the released VS Code extension to move its former
 * `context.storageUri`/`globalStorageUri` buckets. Every operation is
 * non-throwing: a failed move logs the errno code and leaves the legacy data in
 * place, and an existing target entry is never overwritten. Once an entry has
 * moved it no longer exists, so repeat calls on later startups are cheap
 * no-ops.
 */

// Node imports
import { constants, existsSync, type Dirent } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Local imports
import { WORKSPACE_STORAGE_COLLECTIONS_MERGED_PER_CHILD } from '@platform/defaults/workspaceStorage';
import { toErrorMessage } from '@utils/errors/errorMessage';

export interface LegacyDataMigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error != null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

/** Move an entry without replacing a target that appears concurrently. */
async function moveEntryNoReplace(
  legacyPath: string,
  targetPath: string,
): Promise<void> {
  const entry = await lstat(legacyPath);
  if (entry.isFile()) {
    await copyFile(legacyPath, targetPath, constants.COPYFILE_EXCL);
    await unlink(legacyPath);
    return;
  }
  if (entry.isSymbolicLink()) {
    await symlink(await readlink(legacyPath), targetPath);
    await unlink(legacyPath);
    return;
  }

  // Directory rename cannot replace a non-empty directory. It may replace an
  // empty directory created in the race window, which loses no user data.
  try {
    await rename(legacyPath, targetPath);
  } catch (error) {
    if (errorCodeOf(error) !== 'EXDEV') throw error;

    // Copy into a private sibling on the target volume, then publish it with
    // one rename. A failed or racing migration therefore exposes neither a
    // partial directory nor an overwrite of an existing non-empty target.
    const stagingPath = `${targetPath}.migrating-${randomUUID()}`;
    try {
      await cp(legacyPath, stagingPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      await rename(stagingPath, targetPath);
      await rm(legacyPath, { recursive: true });
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  }
}

export async function moveEntryIfAbsent(
  legacyPath: string,
  targetPath: string,
  label: string,
  logger: LegacyDataMigrationLogger,
): Promise<void> {
  if (!existsSync(legacyPath)) return;
  if (existsSync(targetPath)) {
    logger.warn(
      `Skipping legacy data migration for "${label}": an entry already exists at ${targetPath}. Legacy data is still at ${legacyPath}; move it manually if needed.`,
    );
    return;
  }
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await moveEntryNoReplace(legacyPath, targetPath);
    logger.info(`Migrated legacy "${label}" to ${targetPath}.`);
  } catch (error) {
    // Surface the errno code (e.g. EXDEV when the legacy and target trees sit
    // on different volumes, EACCES on permission-restricted trees, ENOSPC
    // when the target volume is full) so a failure is diagnosable from the
    // log line alone — this stays non-throwing/best-effort either way.
    const code = errorCodeOf(error);
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR') {
      logger.warn(
        `Skipping legacy data migration for "${label}": an entry appeared at ${targetPath}. Legacy data is still at ${legacyPath}; move it manually if needed.`,
      );
      return;
    }
    logger.warn(
      `Failed to migrate legacy "${label}" to ${targetPath}${code ? ` (${code})` : ''}. Legacy data is still at ${legacyPath}. Cause: ${toErrorMessage(error)}`,
    );
  }
}

async function readLegacyDirEntries(
  legacyDir: string,
  logger: LegacyDataMigrationLogger,
): Promise<Dirent[] | undefined> {
  // Best-effort: an unreadable legacy directory (EACCES, or ENOTDIR if
  // something unexpected occupies that path) must not abort host startup —
  // it only means this run can't migrate that directory.
  try {
    return await readdir(legacyDir, { withFileTypes: true });
  } catch (error) {
    const code = errorCodeOf(error);
    logger.warn(
      `Failed to read legacy directory ${legacyDir}${code ? ` (${code})` : ''}. Cause: ${toErrorMessage(error)}`,
    );
    return undefined;
  }
}

export interface MergeLegacyStorageBucketOptions {
  /**
   * Top-level directory names holding id-keyed children (e.g. `executions/`,
   * `streamData/`, where every child directory is a globally unique run or
   * stream id), or `all` to apply this rule recursively to every directory. When the
   * target bucket already has one of these — because
   * another host wrote runs into the shared root first — its children are
   * merged one at a time instead of skipping the whole collection.
   */
  readonly mergePerChild: readonly string[] | 'all';
  readonly label: string;
  readonly logger: LegacyDataMigrationLogger;
}

/**
 * Merge one legacy storage bucket into a target bucket, entry by entry.
 *
 * Entries named in `mergePerChild` merge child-by-child; every other entry
 * moves only when the target does not have it yet, and is otherwise skipped
 * with a warning (never overwritten).
 */
export async function mergeLegacyStorageBucket(
  legacyBucket: string,
  targetBucket: string,
  { mergePerChild, label, logger }: MergeLegacyStorageBucketOptions,
): Promise<void> {
  if (legacyBucket === targetBucket) return;
  if (!existsSync(legacyBucket)) return;

  const entries = await readLegacyDirEntries(legacyBucket, logger);
  if (!entries) return;

  for (const entry of entries) {
    const legacyPath = join(legacyBucket, entry.name);
    const targetPath = join(targetBucket, entry.name);
    const entryLabel = `${label}/${entry.name}`;

    const mergeChildren =
      entry.isDirectory() &&
      (mergePerChild === 'all' || mergePerChild.includes(entry.name)) &&
      existsSync(targetPath);
    if (!mergeChildren) {
      await moveEntryIfAbsent(legacyPath, targetPath, entryLabel, logger);
      continue;
    }

    const children = await readLegacyDirEntries(legacyPath, logger);
    if (!children) continue;
    for (const child of children) {
      const legacyChildPath = join(legacyPath, child.name);
      const targetChildPath = join(targetPath, child.name);
      const childLabel = `${entryLabel}/${child.name}`;
      if (
        mergePerChild === 'all' &&
        child.isDirectory() &&
        existsSync(targetChildPath)
      ) {
        await mergeLegacyStorageBucket(legacyChildPath, targetChildPath, {
          mergePerChild: 'all',
          label: childLabel,
          logger,
        });
      } else {
        await moveEntryIfAbsent(
          legacyChildPath,
          targetChildPath,
          childLabel,
          logger,
        );
      }
    }
  }
}

/** Merge a legacy workspace bucket using the shared on-disk layout policy. */
export async function mergeLegacyWorkspaceStorageBucket(
  legacyBucket: string,
  targetBucket: string,
  options: Omit<MergeLegacyStorageBucketOptions, 'mergePerChild'>,
): Promise<void> {
  await mergeLegacyStorageBucket(legacyBucket, targetBucket, {
    ...options,
    mergePerChild: WORKSPACE_STORAGE_COLLECTIONS_MERGED_PER_CHILD,
  });
}
