// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentType } from '@agent/core/AgentDataclass';
import { ToolState } from '@agent/core/ToolState';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import { StorageFS, isValidExecutionId } from '@utils/files';
import {
  getToolUsePersistenceEnabled,
  getToolUsePersistenceTtlHours,
} from '@utils/config';
import type { ExecutionId } from '@agent/types/IdentifierTypes';
import {
  TOOL_USE_SNAPSHOT_VERSION,
  ToolUseSessionSnapshotSchema,
  normalizeSnapshot,
  type SaveToolUseSnapshotPayload,
  type ToolUseSessionSnapshot,
} from './ToolUseSnapshotTypes';

/**
 * Persists tool-use session snapshots to disk. Runtime queue state lives in
 * {@link ToolUseSessionManager}; add only filesystem/persistence helpers here.
 */
const CHANNEL = 'ToolUseSnapshotStore';
const logger = new AgentLogger(CHANNEL);

const STORAGE_DIR = 'toolUseSessions';

async function ensureStorageDir(): Promise<boolean> {
  try {
    await StorageFS.ensureDir(STORAGE_DIR);
    return true;
  } catch (error) {
    logger.warn(
      `Unable to ensure tool-use session directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function cleanupExpiredSnapshots(): Promise<void> {
  const hours = getToolUsePersistenceTtlHours();
  const ttlMs = Math.max(hours, 1) * 60 * 60 * 1000;
  try {
    await StorageFS.cleanupOldFiles(STORAGE_DIR, ttlMs);
  } catch (error) {
    logger.debug(
      `Failed to run tool-use snapshot cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getSnapshotPath(executionId: ExecutionId): string {
  return path.join(STORAGE_DIR, `${executionId}.json`);
}

const migrationState: {
  promise: Promise<void> | null;
  completed: boolean;
} = {
  promise: null,
  completed: false,
};

async function migrateLegacySnapshots(): Promise<void> {
  if (migrationState.completed) {
    return;
  }

  if (!migrationState.promise) {
    migrationState.promise = (async () => {
      if (!(await ensureStorageDir())) {
        return;
      }

      const entries = await StorageFS.readDir(STORAGE_DIR).catch((error) => {
        logger.debug(
          `Unable to enumerate tool-use snapshots for migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [] as [string, vscode.FileType][];
      });

      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) {
          continue;
        }

        const relativePath = path.join(STORAGE_DIR, name);
        const stored = await StorageFS.readJson<unknown>(relativePath).catch(
          (error) => {
            logger.debug(
              `Skipping migration for ${name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          },
        );

        if (typeof stored !== 'string') {
          continue;
        }

        try {
          const raw = JSON.parse(stored);
          const parsed = ToolUseSessionSnapshotSchema.safeParse(raw);
          if (!parsed.success) {
            logger.debug(`Skipping migration for ${name}: validation failed`);
            continue;
          }
          await StorageFS.writeJson(relativePath, parsed.data);
          logger.debug(`Migrated legacy snapshot ${name}`);
        } catch (e) {
          logger.debug(
            `Skipping migration for ${name}: JSON parse failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          continue;
        }
      }
    })()
      .catch((error) => {
        logger.debug(
          `Legacy snapshot migration failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        migrationState.completed = true;
      });
  }

  await migrationState.promise;
}

export const ToolUseSnapshotStore = {
  /**
   * Initializes snapshot persistence: ensures the storage directory exists,
   * cleans up expired snapshots, and migrates legacy snapshot formats.
   * Safe to call multiple times.
   */
  async initialize(): Promise<void> {
    if (!getToolUsePersistenceEnabled()) {
      return;
    }
    await ensureStorageDir();
    await cleanupExpiredSnapshots();
    await migrateLegacySnapshots();
  },

  /**
   * Persists a tool-use session snapshot for the given execution.
   * Validates the payload and skips saving on validation failure.
   * @param payload Snapshot data to persist.
   */
  async save(payload: SaveToolUseSnapshotPayload): Promise<void> {
    if (!getToolUsePersistenceEnabled()) {
      return;
    }
    if (!isValidExecutionId(payload.executionId)) {
      logger.warn(
        `Skipping snapshot save due to invalid execution id: ${payload.executionId}`,
      );
      return;
    }
    if (!(await ensureStorageDir())) {
      return;
    }

    try {
      const snapshot = {
        version: TOOL_USE_SNAPSHOT_VERSION,
        executionId: payload.executionId,
        streamId: payload.streamId,
        agentName: payload.agentName,
        model: payload.model,
        session: {
          agentType: payload.session.agentType ?? AgentType.ToolUse,
          agentCategory: payload.session.agentCategory,
        },
        messages: structuredClone(payload.messages),
        toolState: structuredClone(payload.toolState),
        lastUpdated: Date.now(),
      } as const;

      const validationResult = ToolUseSessionSnapshotSchema.safeParse(snapshot);
      if (!validationResult.success) {
        logger.warn(
          `Snapshot validation failed before save: ${validationResult.error.message}`,
        );
        return;
      }

      await StorageFS.writeJson(
        getSnapshotPath(payload.executionId),
        validationResult.data,
      );
    } catch (error) {
      logger.warn(
        `Failed to save tool-use session snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },

  /**
   * Loads a snapshot by execution id.
   * Returns null if not found or when validation fails.
   * @param executionId Identifier of the execution to load.
   * @returns Normalized snapshot or null.
   */
  async load(executionId: ExecutionId): Promise<ToolUseSessionSnapshot | null> {
    if (!getToolUsePersistenceEnabled() || !isValidExecutionId(executionId)) {
      return null;
    }

    const snapshotPath = getSnapshotPath(executionId);

    try {
      const stored =
        await StorageFS.readJson<ToolUseSessionSnapshot>(snapshotPath);
      const parsed = ToolUseSessionSnapshotSchema.safeParse(stored);
      if (!parsed.success) {
        logger.warn(
          `Failed to parse tool-use session snapshot ${executionId}: ${parsed.error.message}`,
        );
        return null;
      }
      return normalizeSnapshot(parsed.data);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
        return null;
      }
      logger.warn(
        `Failed to load tool-use session snapshot ${executionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  },

  /**
   * Lists all valid snapshots currently stored.
   * Invalid or unreadable entries are skipped.
   * @returns Array of normalized snapshots (may be empty).
   */
  async list(): Promise<ToolUseSessionSnapshot[]> {
    if (!getToolUsePersistenceEnabled()) {
      return [];
    }
    if (!(await ensureStorageDir())) {
      return [];
    }

    await cleanupExpiredSnapshots();

    try {
      const entries = await StorageFS.readDir(STORAGE_DIR);
      const snapshots: ToolUseSessionSnapshot[] = [];
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) {
          continue;
        }
        const executionId = name.replace(/\.json$/, '') as ExecutionId;
        if (!isValidExecutionId(executionId)) {
          continue;
        }
        const snapshot = await this.load(executionId);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }
      return snapshots;
    } catch (error) {
      logger.warn(
        `Failed to enumerate tool-use session snapshots: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  },

  /**
   * Deletes a snapshot for the given execution id.
   * No-op for undefined/invalid ids or when the file does not exist.
   * @param executionId Identifier of the snapshot to delete.
   */
  async delete(executionId: ExecutionId | undefined): Promise<void> {
    if (!executionId || !isValidExecutionId(executionId)) {
      return;
    }

    try {
      await StorageFS.delete(getSnapshotPath(executionId));
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        if (error.code === 'FileNotFound') {
          return;
        }
      }
      logger.debug(
        `Unable to delete snapshot ${executionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },

  /**
   * Deletes all stored snapshots when persistence is enabled.
   */
  async deleteAll(): Promise<void> {
    if (!getToolUsePersistenceEnabled()) {
      return;
    }

    try {
      const snapshots = await this.list();
      await Promise.all(
        snapshots.map((snapshot) => this.delete(snapshot.executionId)),
      );
    } catch (error) {
      logger.warn(
        `Failed to delete all snapshots: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};
