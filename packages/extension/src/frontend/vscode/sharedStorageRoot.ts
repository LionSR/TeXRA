/**
 * Shared `~/.texra` storage root for the VS Code extension.
 *
 * The CLI and desktop app persist executions, transcripts, and memories under
 * `~/.texra/workspace-storage/<id>/` (#7987); the extension historically
 * rooted the same on-disk layout at VS Code's per-extension
 * `context.storageUri`. Wiring the identical `WorkspaceStorageProvider` here
 * means a workspace worked on from any host shows one history (#8622). Only
 * the storage port moves — Memento state, secrets, and `.vscode/settings.json`
 * config stay VS Code-native.
 */
// VS Code imports
import * as vscode from 'vscode';

// Local imports - platform
import {
  mergeLegacyStorageBucket,
  mergeLegacyWorkspaceStorageBucket,
} from '@platform/defaults/legacyDataMigration';
import {
  CUSTOM_AGENTS_STORAGE_DIR,
  EXTERNAL_INQUIRY_THREADS_DIR,
} from '@platform/defaults/globalStorage';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Type imports
import type { LegacyDataMigrationLogger } from '@platform/defaults/legacyDataMigration';
import type { StorageProvider } from '@platform/interfaces';

type BucketMigration = (
  sourcePath: string,
  targetPath: string,
  options: {
    readonly label: string;
    readonly logger: LegacyDataMigrationLogger;
  },
) => Promise<void>;

const GLOBAL_MERGE_PER_CHILD = [
  CUSTOM_AGENTS_STORAGE_DIR,
  EXTERNAL_INQUIRY_THREADS_DIR,
] as const;

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
  const migrationLogger = {
    info: (message: string) => logger.info('extension', message),
    warn: (message: string) => logger.warn('extension', message),
  };
  async function migrateBucket(
    sourcePath: string | undefined,
    getTargetPath: () => string,
    label: string,
    migrate: BucketMigration,
  ): Promise<void> {
    if (!sourcePath) return;
    try {
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
    context.storageUri?.fsPath,
    () => storage.getStoragePath(),
    'vscode-workspace-storage',
    mergeLegacyWorkspaceStorageBucket,
  );
  await migrateBucket(
    context.globalStorageUri?.fsPath,
    () => storage.getGlobalStoragePath(),
    'vscode-global-storage',
    (sourcePath, targetPath, options) =>
      mergeLegacyStorageBucket(sourcePath, targetPath, {
        ...options,
        mergePerChild: GLOBAL_MERGE_PER_CHILD,
      }),
  );
}
