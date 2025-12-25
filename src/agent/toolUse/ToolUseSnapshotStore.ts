// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { ZodError } from 'zod';

// Local imports - agent
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Internal imports
import { AgentLogger } from '@logger/AgentLogger';
import { StorageFS } from '@utils/files';
import {
  getToolUsePersistenceEnabled,
  getToolUsePersistenceTtlHours,
} from '@utils/config';
import {
  TOOL_USE_SNAPSHOT_VERSION,
  ToolUseSessionSnapshotSchema,
  type SaveToolUseSnapshotPayload,
  type ToolUseSessionSnapshot,
} from './ToolUseSessionManager';

/**
 * Persists tool-use session snapshots to disk. Runtime queue state lives in
 * {@link ToolUseResumeQueue}; add only filesystem/persistence helpers here.
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

async function ensureInitialized(): Promise<boolean> {
  if (!getToolUsePersistenceEnabled()) {
    storageState = null;
    return false;
  }

  if (!storageState) {
    storageState = { dirReady: false, cleanupDone: false };
  }

  if (!storageState.dirReady) {
    await StorageFS.ensureDir(STORAGE_DIR);
    storageState.dirReady = true;
  }

  if (!storageState.cleanupDone) {
    await cleanupExpiredSnapshots();
    storageState.cleanupDone = true;
  }

  return true;
}

interface StorageState {
  dirReady: boolean;
  cleanupDone: boolean;
}

let storageState: StorageState | null = null;

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
  async save(
    payload: SaveToolUseSnapshotPayload,
  ): Promise<ToolUseSessionSnapshot | null> {
    if (!(await ensureInitialized())) {
      return null;
    }
    const snapshot = {
      version: TOOL_USE_SNAPSHOT_VERSION,
      executionId: payload.executionId,
      streamId: payload.streamId,
      agentConfig: payload.agentConfig,
      messages: structuredClone(payload.messages),
      store: payload.store.toSnapshot(),
      lastUpdated: Date.now(),
    } as const;

    const validated = ToolUseSessionSnapshotSchema.parse(snapshot);
    await StorageFS.writeJson(getSnapshotPath(payload.executionId), validated);
    return validated;
  },

  /**
   * Loads a snapshot by execution id.
   * Returns null if not found or when validation fails.
   * @param executionId Identifier of the execution to load.
   * @returns Normalized snapshot or null.
   */
  async load(executionId: ExecutionId): Promise<ToolUseSessionSnapshot | null> {
    if (!(await ensureInitialized())) {
      return null;
    }

    const snapshotPath = getSnapshotPath(executionId);

    try {
      const stored =
        await StorageFS.readJson<ToolUseSessionSnapshot>(snapshotPath);
      return ToolUseSessionSnapshotSchema.parse(stored);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === 'FileNotFound'
      ) {
        return null;
      }

      if (error instanceof ZodError || error instanceof SyntaxError) {
        logger.warn(
          `Skipping invalid snapshot at ${snapshotPath}: ${error.message}`,
        );
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
