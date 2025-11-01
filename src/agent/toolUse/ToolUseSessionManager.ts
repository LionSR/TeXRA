// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';
import * as vscode from 'vscode';

// Local imports - agent
import {
  AgentCategory,
  AgentType,
  resolveAgentSessionDescriptor,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import { ToolRuntimeStore, type ToolRuntimeStoreSnapshot } from '@agent/state';
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

const ToolScratchpadSnapshotSchema = z.object({
  texcountStats: z.string().nullable(),
  lastResponse: z.string(),
  accumulatedOutput: z.string(),
});

const ToolMediaSnapshotSchema = z.object({
  mediaFiles: z.array(z.string()),
});

const ToolReasoningSnapshotSchema = z.object({
  thinkingBlocks: z.array(z.unknown()),
  thinkingAdded: z.boolean(),
});

const LegacyToolStateSnapshotSchema = z.object({
  texcountStats: z.string().nullable(),
  lastResponse: z.string(),
  accumulatedOutput: z.string(),
  mediaFiles: z.array(z.string()),
  thinkingBlocks: z.array(z.unknown()),
  thinkingAdded: z.boolean(),
});

const ToolRuntimeStoreSnapshotSchema = z.object({
  scratchpad: ToolScratchpadSnapshotSchema,
  media: ToolMediaSnapshotSchema,
  reasoning: ToolReasoningSnapshotSchema,
});

const SessionDescriptorSchema = z.strictObject({
  agentType: z.enum(AgentType).optional(),
  agentCategory: z.enum(AgentCategory),
});

const ToolUseSessionSnapshotSchema = z.strictObject({
  version: z.literal(SNAPSHOT_VERSION),
  executionId: z.string(),
  streamId: z.string(),
  agentName: z.string(),
  model: z.string(),
  agentSessionKind: z.enum(AgentCategory).optional(),
  session: SessionDescriptorSchema.optional(),
  messages: z.array(z.unknown()),
  toolState: z.union([ToolRuntimeStoreSnapshotSchema, LegacyToolStateSnapshotSchema]),
  lastUpdated: z.number(),
});

type ToolUseSessionSnapshotParsed = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;

export type ToolUseSessionSnapshot = Omit<
  ToolUseSessionSnapshotParsed,
  'agentSessionKind' | 'session'
> & {
  session: Required<AgentSessionDescriptor>;
  toolState: ToolRuntimeStoreSnapshot;
};

interface SavePayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentName: string;
  model: string;
  session: AgentSessionDescriptor;
  messages: ProviderMessage[];
  toolState: ToolRuntimeStore;
}

function toToolStateSnapshot(
  state: ToolRuntimeStore,
): ToolRuntimeStoreSnapshot {
  return ToolRuntimeStoreSnapshotSchema.parse(state.toSnapshot());
}

function hydrateToolState(
  snapshot: ToolUseSessionSnapshot['toolState'],
): ToolRuntimeStore {
  const modern = ToolRuntimeStoreSnapshotSchema.safeParse(snapshot);
  if (modern.success) {
    return ToolRuntimeStore.fromSnapshot(modern.data);
  }

  const legacy = LegacyToolStateSnapshotSchema.parse(snapshot);
  const converted: ToolRuntimeStoreSnapshot = {
    scratchpad: {
      texcountStats: legacy.texcountStats,
      lastResponse: legacy.lastResponse,
      accumulatedOutput: legacy.accumulatedOutput,
    },
    media: { mediaFiles: legacy.mediaFiles },
    reasoning: {
      thinkingBlocks: legacy.thinkingBlocks,
      thinkingAdded: legacy.thinkingAdded,
    },
  };
  return ToolRuntimeStore.fromSnapshot(converted);
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

interface ResumingSessionState {
  queuedFollowUps: string[];
}

function normalizeSnapshot(
  snapshot: ToolUseSessionSnapshotParsed,
): ToolUseSessionSnapshot {
  // If already normalized (has session, no legacy fields), trust it
  if (snapshot.session && !snapshot.agentSessionKind) {
    return snapshot as ToolUseSessionSnapshot;
  }

  // Legacy path: derive descriptor and create new normalized object
  const descriptor =
    snapshot.session ??
    resolveAgentSessionDescriptor(AgentType.ToolUse, snapshot.agentSessionKind);

  const {
    agentSessionKind: _legacyKind,
    session: _legacySession,
    ...rest
  } = snapshot;

  const toolState = ToolRuntimeStoreSnapshotSchema.safeParse(rest.toolState);
  const normalizedToolState = toolState.success
    ? toolState.data
    : ((): ToolRuntimeStoreSnapshot => {
        const legacy = LegacyToolStateSnapshotSchema.parse(rest.toolState);
        return {
          scratchpad: {
            texcountStats: legacy.texcountStats,
            lastResponse: legacy.lastResponse,
            accumulatedOutput: legacy.accumulatedOutput,
          },
          media: { mediaFiles: legacy.mediaFiles },
          reasoning: {
            thinkingBlocks: legacy.thinkingBlocks,
            thinkingAdded: legacy.thinkingAdded,
          },
        };
      })();

  return {
    ...rest,
    toolState: normalizedToolState,
    session: {
      agentType: descriptor.agentType ?? AgentType.ToolUse,
      agentCategory: descriptor.agentCategory,
    },
  };
}

export class ToolUseSessionManager {
  private static readonly pendingSnapshots = new Map<
    StreamTabId,
    ToolUseSessionSnapshot
  >();
  private static readonly resumingSessions = new Map<
    StreamTabId,
    ResumingSessionState
  >();
  private static migrationPromise: Promise<void> | null = null;
  private static migrationCompleted = false;

  /**
   * Determines whether the provided stream is currently marked as resuming.
   * @param streamId - The stream identifier to check.
   */
  public static isResumingSession(streamId: StreamTabId): boolean {
    return this.resumingSessions.has(streamId);
  }

  /**
   * Checks if tool-use session persistence is enabled
   * @returns True if persistence is enabled, false otherwise
   */
  public static isPersistenceEnabled(): boolean {
    return getToolUsePersistenceEnabled();
  }

  /**
   * Registers persisted snapshots so they can be resumed lazily.
   * @param snapshots - The snapshots to cache for later use.
   */
  public static registerPendingSnapshots(
    snapshots: ToolUseSessionSnapshot[],
  ): void {
    if (snapshots.length === 0) {
      return;
    }

    for (const snapshot of snapshots) {
      this.pendingSnapshots.set(snapshot.streamId as StreamTabId, snapshot);
    }

    logger.debug(
      `Registered ${snapshots.length} pending tool-use snapshots for lazy resume.`,
    );
  }

  /**
   * Retrieves and removes a cached snapshot for the provided stream.
   * @param streamId - The stream identifier to lookup.
   * @returns The cached snapshot if found.
   */
  public static getSnapshotForStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    return this.pendingSnapshots.get(streamId);
  }

  /**
   * Marks a stream as resuming so follow-ups can be queued until the agent is ready.
   * @param streamId - The stream identifier being resumed.
   */
  public static setResumingSession(streamId: StreamTabId): void {
    if (this.resumingSessions.has(streamId)) {
      return;
    }

    this.resumingSessions.set(streamId, { queuedFollowUps: [] });
    logger.debug(`Marked stream ${streamId} as resuming.`);
  }

  /**
   * Removes and returns a cached snapshot for the provided stream.
   * @param streamId - The stream identifier to lookup.
   * @returns The cached snapshot if found.
   */
  public static consumeSnapshotForStream(
    streamId: StreamTabId,
  ): ToolUseSessionSnapshot | undefined {
    const snapshot = this.pendingSnapshots.get(streamId);
    if (snapshot) {
      this.pendingSnapshots.delete(streamId);
      logger.debug(
        `Consuming pending snapshot for stream ${streamId} to resume lazily.`,
      );
    }
    return snapshot;
  }

  /**
   * Adds a follow-up to the queue while a snapshot is being resumed.
   * @param streamId - The stream identifier to enqueue under.
   * @param followUp - The follow-up text to queue.
   * @returns True if the follow-up was queued, false if no resuming session exists.
   */
  public static enqueueFollowUpWhileResuming(
    streamId: StreamTabId,
    followUp: string,
  ): boolean {
    const entry = this.resumingSessions.get(streamId);
    if (!entry) {
      return false;
    }

    entry.queuedFollowUps.push(followUp);
    logger.debug(
      `Queued follow-up while resuming stream ${streamId}; ${entry.queuedFollowUps.length} waiting.`,
    );
    return true;
  }

  /**
   * Retrieves and clears queued follow-ups for a resuming session.
   * @param streamId - The stream identifier to drain.
   */
  public static drainQueuedFollowUps(streamId: StreamTabId): string[] {
    const entry = this.resumingSessions.get(streamId);
    if (!entry) {
      return [];
    }

    const queued = entry.queuedFollowUps.splice(0);
    logger.debug(
      `Drained ${queued.length} queued follow-ups for stream ${streamId} after resume.`,
    );
    return queued;
  }

  /**
   * Clears a resuming session without draining queued follow-ups (used on failure).
   * @param streamId - The stream identifier to clear.
   */
  public static clearResumingSession(streamId: StreamTabId): void {
    if (this.resumingSessions.delete(streamId)) {
      logger.debug(`Cleared resuming session tracking for stream ${streamId}.`);
    }
  }

  /**
   * Checks if a snapshot is cached for the provided stream identifier.
   * @param streamId - The stream identifier to check.
   */
  public static hasPendingSnapshot(streamId: StreamTabId): boolean {
    return this.pendingSnapshots.has(streamId);
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
      // Store only what's necessary - session is the canonical descriptor
      const snapshot: ToolUseSessionSnapshot = {
        version: SNAPSHOT_VERSION,
        executionId: payload.executionId,
        streamId: payload.streamId,
        agentName: payload.agentName,
        model: payload.model,
        session: {
          agentType: payload.session.agentType ?? AgentType.ToolUse,
          agentCategory: payload.session.agentCategory,
        },
        messages: structuredClone(payload.messages),
        toolState: toToolStateSnapshot(payload.toolState),
        lastUpdated: Date.now(),
      };

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

    for (const [streamId, snapshot] of this.pendingSnapshots.entries()) {
      if (snapshot.executionId === executionId) {
        this.pendingSnapshots.delete(streamId);
        break;
      }
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
   * Hydrates a ToolRuntimeStore object from a snapshot
   * @param snapshot - The snapshot containing the tool state data
   * @returns A new ToolRuntimeStore instance with the hydrated data
   */
  public static hydrateToolStateFromSnapshot(
    snapshot: ToolUseSessionSnapshot,
  ): ToolRuntimeStore {
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

  public static async migrateLegacySnapshots(): Promise<void> {
    if (this.migrationCompleted) {
      return;
    }

    if (!this.migrationPromise) {
      this.migrationPromise = (async () => {
        try {
          if (!(await ensureStorageDir())) {
            return;
          }

          const entries = await StorageFS.readDir(STORAGE_DIR).catch(
            (error) => {
              logger.debug(
                `Unable to enumerate tool-use snapshots for migration: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return null;
            },
          );

          if (!entries) {
            return;
          }

          for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.json')) {
              continue;
            }

            const relativePath = path.join(STORAGE_DIR, name);

            try {
              const stored = await StorageFS.readJson<unknown>(relativePath);
              if (typeof stored !== 'string') {
                continue;
              }

              const normalized = JSON.parse(stored);
              const parsed = ToolUseSessionSnapshotSchema.safeParse(normalized);

              if (!parsed.success) {
                logger.debug(
                  `Skipping migration for ${name}: validation failed (${parsed.error.message})`,
                );
                continue;
              }

              await StorageFS.writeJson(relativePath, parsed.data);
              logger.debug(`Migrated legacy snapshot ${name}`);
            } catch (error) {
              logger.debug(
                `Skipping migration for ${name}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        } catch (error) {
          logger.debug(
            `Legacy snapshot migration failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          this.migrationCompleted = true;
        }
      })();
    }

    await this.migrationPromise;
  }
}
