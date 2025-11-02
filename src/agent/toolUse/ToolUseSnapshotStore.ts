// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import { AgentType } from '@agent/core/AgentDataclass';

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

async function cleanupExpiredSnapshots(): Promise<void> {
  const hours = getToolUsePersistenceTtlHours();
  const ttlMs = Math.max(hours, 1) * 60 * 60 * 1000;
  await StorageFS.cleanupOldFiles(STORAGE_DIR, ttlMs);
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
      const entries = await StorageFS.readDir(STORAGE_DIR);

      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) {
          continue;
        }

        const relativePath = path.join(STORAGE_DIR, name);
        const stored = await StorageFS.readJson<unknown>(relativePath);
        const parsed = ToolUseSessionSnapshotSchema.safeParse(stored);
        if (!parsed.success) {
          logger.debug(`Skipping migration for ${name}: validation failed`);
          continue;
        }
        try {
          await StorageFS.writeJson(relativePath, parsed.data);
          logger.debug(`Migrated legacy snapshot ${name}`);
        } catch (error) {
          logger.debug(
            `Skipping migration for ${name}: write failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
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

let persistenceEnabled: boolean | null = null;
let storageReady = false;
let cleanupPerformed = false;

async function ensureInitialized(): Promise<boolean> {
  if (persistenceEnabled === null) {
    persistenceEnabled = getToolUsePersistenceEnabled();
  }

  if (!persistenceEnabled) {
    return false;
  }

  if (!storageReady) {
    await StorageFS.ensureDir(STORAGE_DIR);
    storageReady = true;
  }

  if (!cleanupPerformed) {
    await cleanupExpiredSnapshots();
    cleanupPerformed = true;
  }

  await migrateLegacySnapshots();
  return true;
}

export const ToolUseSnapshotStore = {
  /**
   * Initializes snapshot persistence: ensures the storage directory exists,
   * cleans up expired snapshots, and migrates legacy snapshot formats.
   * Safe to call multiple times.
   */
  async initialize(): Promise<void> {
    await ensureInitialized();
  },

  /**
   * Persists a tool-use session snapshot for the given execution.
   * Validates the payload and skips saving on validation failure.
   * @param payload Snapshot data to persist.
   */
  async save(payload: SaveToolUseSnapshotPayload): Promise<void> {
    if (!(await ensureInitialized())) {
      return;
    }
    if (!isValidExecutionId(payload.executionId)) {
      throw new Error(`Invalid execution id: ${payload.executionId}`);
    }

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

    const validated = ToolUseSessionSnapshotSchema.parse(snapshot);
    await StorageFS.writeJson(getSnapshotPath(payload.executionId), validated);
  },

  /**
   * Loads a snapshot by execution id.
   * Returns null if not found or when validation fails.
   * @param executionId Identifier of the execution to load.
   * @returns Normalized snapshot or null.
   */
  async load(executionId: ExecutionId): Promise<ToolUseSessionSnapshot | null> {
    if (!(await ensureInitialized()) || !isValidExecutionId(executionId)) {
      return null;
    }

    const snapshotPath = getSnapshotPath(executionId);

    try {
      const stored =
        await StorageFS.readJson<ToolUseSessionSnapshot>(snapshotPath);
      const parsed = ToolUseSessionSnapshotSchema.parse(stored);
      return normalizeSnapshot(parsed);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Lists all valid snapshots currently stored.
   * Invalid or unreadable entries are skipped.
   * @returns Array of normalized snapshots (may be empty).
   */
  async list(): Promise<ToolUseSessionSnapshot[]> {
    if (!(await ensureInitialized())) {
      return [];
    }
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
  },

  /**
   * Deletes a snapshot for the given execution id.
   * No-op for undefined/invalid ids or when the file does not exist.
   * @param executionId Identifier of the snapshot to delete.
   */
  async delete(executionId: ExecutionId): Promise<void> {
    if (!(await ensureInitialized())) {
      return;
    }

    if (!isValidExecutionId(executionId)) {
      throw new Error(`Invalid execution id: ${executionId}`);
    }

    try {
      await StorageFS.delete(getSnapshotPath(executionId));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
        return;
      }
      throw error;
    }
  },

  /**
   * Deletes all stored snapshots when persistence is enabled.
   */
  async deleteAll(): Promise<void> {
    if (!(await ensureInitialized())) {
      return;
    }

    const snapshots = await this.list();
    await Promise.all(
      snapshots.map((snapshot) => this.delete(snapshot.executionId)),
    );
  },
};
