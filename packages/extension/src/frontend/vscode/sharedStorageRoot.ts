/**
 * Shared `~/.texra` storage root for the VS Code extension.
 *
 * The CLI and desktop app persist executions, transcripts, and memories under
 * `~/.texra/workspace-storage/<id>/` (#7987); the extension historically
 * rooted the same on-disk layout at VS Code's per-extension
 * `context.storageUri`. Wiring the identical `WorkspaceStorageProvider` here
 * means a workspace worked on from any host shows one history (#8622). Only
 * the storage port moves. VS Code Memento state and SecretStorage remain
 * host-owned; TeXRA configuration uses the shared JSON stores.
 */
// Node imports
import { join } from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  CUSTOM_AGENTS_STORAGE_DIR,
  EXTERNAL_INQUIRY_THREADS_DIR,
  WORKSPACE_STORAGE_LAYOUT,
} from '@common/storage/storageLayout';
import { createLog } from '@logger/logUtils';
import type { StorageProvider } from '@platform/interfaces';
import {
  mergeLegacyStorageBucket,
  mergeLegacyWorkspaceStorageBucket,
  type LegacyDataMigrationLogger,
} from '@platform/defaults/legacyDataMigration';
import { toErrorMessage } from '@utils/errors/errorMessage';

type BucketMigration = (
  sourcePath: string,
  targetPath: string,
  options: {
    readonly label: string;
    readonly logger: LegacyDataMigrationLogger;
  },
) => Promise<void>;

const log = createLog('extension');

const mergeTaskRuns: BucketMigration = (sourcePath, targetPath, options) =>
  mergeLegacyStorageBucket(sourcePath, targetPath, {
    ...options,
    mergePerChild: 'all',
  });

/**
 * Best-effort, one-time move of the extension's legacy `context.storageUri` /
 * `globalStorageUri` data into the shared `~/.texra` root. Non-throwing and
 * idempotent (moved entries no longer exist on the next activation); call it
 * before `initPlatform()` so nothing reads the shared root mid-move.
 */
export async function migrateLegacyVscodeStorage(
  context: vscode.ExtensionContext,
  storage: StorageProvider,
): Promise<void> {
  const migrationLogger = { info: log.info, warn: log.warn };
  async function migrateBucket(
    getSourcePath: () => string | undefined,
    getTargetPath: () => string,
    label: string,
    migrate: BucketMigration,
  ): Promise<void> {
    try {
      const sourcePath = getSourcePath();
      if (!sourcePath) return;
      await migrate(sourcePath, getTargetPath(), {
        label,
        logger: migrationLogger,
      });
    } catch (error) {
      migrationLogger.warn(
        `${label} migration failed; legacy data stays in place. Cause: ${toErrorMessage(error)}`,
      );
    }
  }

  // Resolve and migrate each bucket independently: a workspace-root failure
  // must not prevent an otherwise valid global migration, or vice versa.
  await migrateBucket(
    () => context.storageUri?.fsPath,
    () => storage.getStoragePath(),
    'vscode-workspace-storage',
    mergeLegacyWorkspaceStorageBucket,
  );
  await migrateBucket(
    () =>
      context.storageUri &&
      join(context.storageUri.fsPath, WORKSPACE_STORAGE_LAYOUT.legacyRuns),
    () => join(storage.getStoragePath(), WORKSPACE_STORAGE_LAYOUT.runs),
    'vscode-workspace-storage/taskRuns',
    mergeTaskRuns,
  );
  await migrateBucket(
    () => join(storage.getStoragePath(), WORKSPACE_STORAGE_LAYOUT.legacyRuns),
    () => join(storage.getStoragePath(), WORKSPACE_STORAGE_LAYOUT.runs),
    'shared-workspace-storage/taskRuns',
    mergeTaskRuns,
  );
  await migrateBucket(
    () => context.globalStorageUri?.fsPath,
    () => storage.getGlobalStoragePath(),
    'vscode-global-storage',
    (sourcePath, targetPath, options) =>
      mergeLegacyStorageBucket(sourcePath, targetPath, {
        ...options,
        mergePerChild: [
          CUSTOM_AGENTS_STORAGE_DIR,
          EXTERNAL_INQUIRY_THREADS_DIR,
        ],
      }),
  );
}
