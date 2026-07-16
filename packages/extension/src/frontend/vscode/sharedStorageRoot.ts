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
import { mergeLegacyStorageBucket } from '@platform/defaults/legacyDataMigration';
import {
  LEGACY_RUNS_STORAGE_DIR,
  MEMORY_STORAGE_DIR,
  RUNS_STORAGE_DIR,
} from '@platform/defaults/workspaceStorage';
import { STREAM_DATA_DIR } from '@transcript/streamDataPaths';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Type imports
import type { StorageProvider } from '@platform/interfaces';

/**
 * Collections merged one child at a time when the shared bucket already holds
 * data written by the CLI or desktop: run/stream directories are keyed by
 * globally unique ids, and memory files merge safely too because children are
 * never overwritten. Everything else moves only if absent, never clobbering.
 */
const MERGE_PER_CHILD = [
  RUNS_STORAGE_DIR,
  LEGACY_RUNS_STORAGE_DIR,
  STREAM_DATA_DIR,
  MEMORY_STORAGE_DIR,
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
  // The merge helpers swallow per-entry I/O errors, but getStoragePath() /
  // getGlobalStoragePath() do real disk I/O (mkdir, sidecar write) — a failure
  // there must degrade to a warning, never break activation.
  try {
    if (context.storageUri) {
      await mergeLegacyStorageBucket(
        context.storageUri.fsPath,
        storage.getStoragePath(),
        {
          mergePerChild: MERGE_PER_CHILD,
          label: 'vscode-workspace-storage',
          logger: migrationLogger,
        },
      );
    }
    if (context.globalStorageUri) {
      await mergeLegacyStorageBucket(
        context.globalStorageUri.fsPath,
        storage.getGlobalStoragePath(),
        {
          mergePerChild: MERGE_PER_CHILD,
          label: 'vscode-global-storage',
          logger: migrationLogger,
        },
      );
    }
  } catch (error) {
    migrationLogger.warn(
      `Legacy storage migration failed; legacy data stays in place. Cause: ${toErrorMessage(error)}`,
    );
  }
}
