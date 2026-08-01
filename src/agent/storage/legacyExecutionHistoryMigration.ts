/**
 * One-time migration boundary for execution history written before the
 * per-execution KV layout.
 *
 * A durable marker prevents every new host process from probing the retired
 * index and workspace-state layouts. The marker is committed only after both
 * sources have been dealt with successfully, so incomplete work remains
 * retryable.
 */

import pMap from 'p-map';

import {
  type AgentConfig,
  AgentConfigSchema,
} from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';
import { platform, type Platform } from '@platform/platform';
import { RUNS_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import type { ExecutionId } from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getExecutionStore } from './ExecutionKVStore';
import { runWithInactiveExecutionLease } from './executionLease';

const CHANNEL = 'LegacyExecutionHistoryMigration';
const INDEX_PATH = `${RUNS_STORAGE_DIR}/index.json`;
const MIGRATION_MARKER_PATH = `${RUNS_STORAGE_DIR}/.legacy-history-migration-v1`;
const LEGACY_HISTORY_KEY = 'texra.agentHistory';
const LEGACY_BACKFILL_CONCURRENCY = 32;

/**
 * In-flight or completed migration per workspace path. The promise is the
 * process-local concurrency guard; the marker is the durable cross-process
 * completion record. Incomplete or failed work is forgotten so a later
 * listing retries it.
 */
const migrationsByWorkspace = new Map<string | undefined, Promise<void>>();
let migrationPlatform: Platform | undefined;

export async function migrateLegacyExecutionHistoryOnce(
  workspacePath: string | undefined,
): Promise<void> {
  const currentPlatform = platform();
  if (currentPlatform !== migrationPlatform) {
    migrationPlatform = currentPlatform;
    migrationsByWorkspace.clear();
  }

  const inFlight = migrationsByWorkspace.get(workspacePath);
  if (inFlight) return inFlight;

  const migration = migrateIfNeeded().then(
    (complete) => {
      if (!complete) migrationsByWorkspace.delete(workspacePath);
    },
    (error: unknown) => {
      migrationsByWorkspace.delete(workspacePath);
      throw error;
    },
  );
  migrationsByWorkspace.set(workspacePath, migration);
  await migration;
}

async function migrateIfNeeded(): Promise<boolean> {
  if (await StorageFS.exists(MIGRATION_MARKER_PATH)) return true;

  const indexMigrated = await migrateIndexJson();
  const workspaceStateMigrated = await migrateWorkspaceState();
  if (!indexMigrated || !workspaceStateMigrated) return false;

  try {
    await StorageFS.ensureDir(RUNS_STORAGE_DIR);
    await StorageFS.writeAtomic(MIGRATION_MARKER_PATH, 'completed\n');
    return true;
  } catch (error) {
    logger.warn(
      CHANNEL,
      `Failed to record legacy history migration: ${toErrorMessage(error)}`,
    );
    return false;
  }
}

/** Migrate entries from executions/index.json into per-execution KV. */
async function migrateIndexJson(): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await StorageFS.readJson<unknown>(INDEX_PATH);
  } catch (error) {
    // Nothing to migrate only when the legacy file is genuinely absent. Any
    // other read failure leaves history behind, so report it and retry later.
    if (isFileNotFoundError(error)) return true;
    logger.warn(
      CHANNEL,
      `Failed to read legacy ${INDEX_PATH}: ${toErrorMessage(error)}`,
    );
    return false;
  }

  if (!Array.isArray(raw)) {
    logger.warn(
      CHANNEL,
      `Legacy ${INDEX_PATH} is not an array; leaving it untouched and retrying later.`,
    );
    return false;
  }
  if (raw.length === 0) return true;

  if (!(await backfillEntries(raw))) return false;

  try {
    await StorageFS.delete(INDEX_PATH);
    return true;
  } catch (error) {
    logger.warn(
      CHANNEL,
      `Failed to delete legacy ${INDEX_PATH}: ${toErrorMessage(error)}`,
    );
    return false;
  }
}

/** Migrate entries from workspace state into per-execution KV. */
async function migrateWorkspaceState(): Promise<boolean> {
  const { workspace, workspaceState } = platform();
  const paths = [
    workspace.getWorkspacePath(),
    ...(workspace.getLegacyWorkspacePaths?.() ?? []),
  ];
  const storageKeys = [
    ...new Set(paths.map((path) => getWorkspaceStorageKey(path))),
  ];

  let migratedAll = true;
  for (const storageKey of storageKeys) {
    const legacy = workspaceState.get<unknown[]>(storageKey, []);
    if (!Array.isArray(legacy)) {
      migratedAll = false;
      logger.warn(
        CHANNEL,
        `Legacy workspace state key ${storageKey} is not an array; leaving it untouched and retrying later.`,
      );
      continue;
    }
    if (legacy.length === 0) continue;

    if (!(await backfillEntries(legacy))) {
      migratedAll = false;
      continue;
    }

    try {
      await workspaceState.update(storageKey, []);
    } catch (error) {
      migratedAll = false;
      logger.warn(
        CHANNEL,
        `Failed to clear workspace state key: ${toErrorMessage(error)}`,
      );
    }
  }
  return migratedAll;
}

function getWorkspaceStorageKey(workspacePath: string | undefined): string {
  return workspacePath
    ? `${LEGACY_HISTORY_KEY}.${workspacePath}`
    : LEGACY_HISTORY_KEY;
}

/**
 * Backfill per-execution KV from legacy history entries.
 * Only writes if meta.json does not already exist.
 */
async function backfillEntries(entries: unknown[]): Promise<boolean> {
  const migrated = await pMap(
    entries,
    async (rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object') return true;

      const candidate = rawEntry as {
        id?: ExecutionId;
        timestamp?: string;
        agentConfig?: AgentConfig;
        config?: AgentConfig;
        parentExecutionId?: ExecutionId;
      };

      const rawConfig = candidate.agentConfig ?? candidate.config;
      if (!candidate.id || !candidate.timestamp || !rawConfig) return true;
      const executionId = candidate.id;
      const timestamp = candidate.timestamp;

      let normalizedConfig: AgentConfig;
      try {
        normalizedConfig = AgentConfigSchema.parse(rawConfig);
      } catch {
        logger.warn(CHANNEL, `Skipping malformed legacy entry ${candidate.id}`);
        return true;
      }

      const result = await runWithInactiveExecutionLease(
        executionId,
        async () => {
          const store = getExecutionStore(executionId);
          if (await store.exists('meta')) return;
          await Promise.all([
            store.writeMeta({
              timestamp,
              parentExecutionId: candidate.parentExecutionId,
            }),
            store.writeConfig(normalizedConfig),
          ]);
        },
      );
      return result.status === 'performed';
    },
    {
      concurrency: LEGACY_BACKFILL_CONCURRENCY,
      stopOnError: false,
    },
  );
  return migrated.every(Boolean);
}
