// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';
import * as vscode from 'vscode';

// Local imports - agent
import { AgentSessionKind } from '@agent/core/AgentDataclass';
import { ToolState } from '@agent/core/ToolState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import { StorageFS, isValidExecutionId } from '@utils/files';
import {
  DEFAULT_TOOL_USE_PERSISTENCE_TTL_HOURS,
  getToolUsePersistenceEnabled,
  getToolUsePersistenceTtlHours,
} from '@utils/config';

const CHANNEL = 'ToolUseSessionManager';
const logger = new AgentLogger(CHANNEL);

const STORAGE_DIR = 'toolUseSessions';
const SNAPSHOT_VERSION = 1;

const ToolStateSnapshotSchema = z.object({
  texcountStats: z.string().nullable(),
  lastResponse: z.string(),
  accumulatedOutput: z.string(),
  mediaFiles: z.array(z.string()),
  thinkingBlocks: z.array(z.unknown()),
  thinkingAdded: z.boolean(),
});

const ToolUseSessionSnapshotSchema = z
  .object({
    version: z.literal(SNAPSHOT_VERSION),
    executionId: z.string(),
    streamId: z.string(),
    agentName: z.string(),
    model: z.string(),
    agentSessionKind: z.nativeEnum(AgentSessionKind),
    messages: z.array(z.unknown()),
    toolState: ToolStateSnapshotSchema,
    lastUpdated: z.number(),
  })
  .strict();

export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;

interface SavePayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentName: string;
  model: string;
  agentSessionKind: AgentSessionKind;
  messages: ProviderMessage[];
  toolState: ToolState;
}

function toToolStateSnapshot(
  state: ToolState,
): ToolUseSessionSnapshot['toolState'] {
  return ToolStateSnapshotSchema.parse(structuredClone(state));
}

function hydrateToolState(
  snapshot: ToolUseSessionSnapshot['toolState'],
): ToolState {
  return Object.assign(new ToolState(), structuredClone(snapshot));
}

async function ensureStorageDir(): Promise<boolean> {
  try {
    await StorageFS.ensureDir(STORAGE_DIR);
    return true;
  } catch (error) {
    logger.warn(
      `Unable to ensure tool-use session directory: ${error instanceof Error ? error.message : String(error)}`,
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
      `Failed to run tool-use snapshot cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getSnapshotPath(executionId: ExecutionId): string {
  return path.join(STORAGE_DIR, `${executionId}.json`);
}

export class ToolUseSessionManager {
  /**
   * Checks if tool-use session persistence is enabled
   * @returns True if persistence is enabled, false otherwise
   */
  public static isPersistenceEnabled(): boolean {
    return getToolUsePersistenceEnabled();
  }

  /**
   * Saves a tool-use session snapshot to persistent storage
   * @param payload - The snapshot data to save
   */
  public static async saveSnapshot(payload: SavePayload): Promise<void> {
    if (!this.isPersistenceEnabled()) {
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
      const snapshot: ToolUseSessionSnapshot = {
        version: SNAPSHOT_VERSION,
        executionId: payload.executionId,
        streamId: payload.streamId,
        agentName: payload.agentName,
        model: payload.model,
        agentSessionKind: payload.agentSessionKind,
        messages: structuredClone(payload.messages),
        toolState: toToolStateSnapshot(payload.toolState),
        lastUpdated: Date.now(),
      };

      const json = JSON.stringify(snapshot, null, 2);
      await StorageFS.write(getSnapshotPath(payload.executionId), json);
    } catch (error) {
      logger.warn(
        `Failed to save tool-use session snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Loads a tool-use session snapshot from persistent storage
   * @param executionId - The ID of the session to load
   * @returns The snapshot if found and valid, null otherwise
   */
  public static async loadSnapshot(
    executionId: ExecutionId,
  ): Promise<ToolUseSessionSnapshot | null> {
    if (!this.isPersistenceEnabled() || !isValidExecutionId(executionId)) {
      return null;
    }

    try {
      const raw = await StorageFS.read(getSnapshotPath(executionId));
      const parsed = JSON.parse(raw);
      return ToolUseSessionSnapshotSchema.parse(parsed);
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        if (error.code === 'FileNotFound') {
          return null;
        }
      }
      logger.warn(
        `Failed to load tool-use session snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Deletes a tool-use session snapshot from persistent storage
   * @param executionId - The ID of the session to delete
   */
  public static async deleteSnapshot(
    executionId: ExecutionId | undefined,
  ): Promise<void> {
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
        `Unable to delete snapshot ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Lists all persisted tool-use session snapshots
   * @returns Array of valid snapshots, expired snapshots are automatically cleaned up
   */
  public static async listSnapshots(): Promise<ToolUseSessionSnapshot[]> {
    if (!this.isPersistenceEnabled()) {
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
        if (!name.endsWith('.json') || type !== vscode.FileType.File) {
          continue;
        }
        const executionId = name.replace(/\.json$/, '');
        if (!isValidExecutionId(executionId as ExecutionId)) {
          continue;
        }
        const snapshot = await this.loadSnapshot(executionId as ExecutionId);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }
      return snapshots;
    } catch (error) {
      logger.warn(
        `Failed to enumerate tool-use session snapshots: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Hydrates a ToolState object from a snapshot
   * @param snapshot - The snapshot containing the tool state data
   * @returns A new ToolState instance with the hydrated data
   */
  public static hydrateToolStateFromSnapshot(
    snapshot: ToolUseSessionSnapshot,
  ): ToolState {
    return hydrateToolState(snapshot.toolState);
  }

  /**
   * Deletes all persisted tool-use session snapshots
   * @returns Promise that resolves when all snapshots are deleted
   */
  public static async deleteAllSnapshots(): Promise<void> {
    if (!this.isPersistenceEnabled()) {
      return;
    }

    try {
      const snapshots = await this.listSnapshots();
      await Promise.all(
        snapshots.map((snapshot) => this.deleteSnapshot(snapshot.executionId)),
      );
    } catch (error) {
      logger.warn(
        `Failed to delete all snapshots: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
