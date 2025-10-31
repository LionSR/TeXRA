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
import { ToolState } from '@agent/core/ToolState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - utilities
import { StorageFS, isValidExecutionId } from '@utils/files';
import {
  getToolUsePersistenceEnabled,
  getToolUsePersistenceTtlHours,
} from '@utils/config';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

/**
 * Persists tool-use session snapshots to disk. Runtime queue state lives in
 * {@link ToolUseSessionManager}; add only filesystem/persistence helpers here.
 */
const CHANNEL = 'ToolUseSnapshotStore';
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
  toolState: ToolStateSnapshotSchema,
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
};

export interface SaveToolUseSnapshotPayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentName: string;
  model: string;
  session: AgentSessionDescriptor;
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

function normalizeSnapshot(
  snapshot: ToolUseSessionSnapshotParsed,
): ToolUseSessionSnapshot {
  if (snapshot.session && !snapshot.agentSessionKind) {
    return snapshot as ToolUseSessionSnapshot;
  }

  const descriptor =
    snapshot.session ??
    resolveAgentSessionDescriptor(AgentType.ToolUse, snapshot.agentSessionKind);

  const {
    agentSessionKind: _legacyKind,
    session: _legacySession,
    ...rest
  } = snapshot;

  return {
    ...rest,
    session: {
      agentType: descriptor.agentType ?? AgentType.ToolUse,
      agentCategory: descriptor.agentCategory,
    },
  };
}

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

let migrationPromise: Promise<void> | null = null;
let migrationCompleted = false;

async function migrateLegacySnapshots(): Promise<void> {
  if (migrationCompleted) {
    return;
  }

  if (!migrationPromise) {
    migrationPromise = (async () => {
      try {
        if (!(await ensureStorageDir())) {
          return;
        }

        const entries = await StorageFS.readDir(STORAGE_DIR).catch((error) => {
          logger.debug(
            `Unable to enumerate tool-use snapshots for migration: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        });

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
        migrationCompleted = true;
      }
    })();
  }

  await migrationPromise;
}

export const ToolUseSnapshotStore = {
  isPersistenceEnabled(): boolean {
    return getToolUsePersistenceEnabled();
  },

  async initialize(): Promise<void> {
    if (!this.isPersistenceEnabled()) {
      return;
    }
    await ensureStorageDir();
    await cleanupExpiredSnapshots();
    await migrateLegacySnapshots();
  },

  async save(payload: SaveToolUseSnapshotPayload): Promise<void> {
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
        `Failed to save tool-use session snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },

  async load(executionId: ExecutionId): Promise<ToolUseSessionSnapshot | null> {
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
  },

  async list(): Promise<ToolUseSessionSnapshot[]> {
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

  async deleteAll(): Promise<void> {
    if (!this.isPersistenceEnabled()) {
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

  hydrateToolStateFromSnapshot(
    snapshot: ToolUseSessionSnapshot,
  ): ToolState {
    return hydrateToolState(snapshot.toolState);
  },

  async migrateLegacySnapshots(): Promise<void> {
    if (!this.isPersistenceEnabled()) {
      return;
    }
    await migrateLegacySnapshots();
  },
};

