/**
 * Per-stream-tab disk-backed storage.
 *
 * Each stream tab gets its own directory under `streamData/`:
 *
 *   streamData/
 *     {encoded(streamTabId)}/
 *       meta.json              → StreamTabMeta
 *       outputFiles.json       → serialized output files (run → round → files)
 *       missingOutputs.json    → serialized missing outputs (run → round → paths)
 *       usageStats.json        → serialized usage stats (run → stats)
 *       runInstructions.json   → serialized run instructions (run → update)
 *
 * Follows the ExecutionKVStore pattern: KVStore per entity, typed accessors
 * with Zod validation, LRU cache of store instances.
 */

import * as path from 'path';

import { z } from 'zod';

import {
  InstructionUpdateSchema,
  OutputFileInfoSchema,
  TokenUsageStatsSchema,
  type InstructionUpdate,
  type OutputFileInfo,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { KVStore } from '@common/storage';
import { TaskStateSchema } from '@logger/TaskState';

import {
  OutputFilesDataSchema,
  MissingOutputsDataSchema,
  UsageDataSchema,
} from './streamTabSchemas';

// ============================================================================
// Key constants
// ============================================================================

const KEYS = {
  META: 'meta',
  OUTPUT_FILES: 'outputFiles',
  MISSING_OUTPUTS: 'missingOutputs',
  USAGE_STATS: 'usageStats',
  RUN_INSTRUCTIONS: 'runInstructions',
} as const;

export const STREAM_DATA_DIR = 'streamData';

// ============================================================================
// Schemas — source of truth for all persisted shapes
// ============================================================================

/** Meta: small per-stream scalars consolidated into one file. */
export const StreamTabMetaSchema = z.object({
  activeRunId: z.string().nullable().optional(),
  parentStreamId: z.string().optional(),
  executionId: z.string().optional(),
  taskState: TaskStateSchema.optional(),
});

export type StreamTabMeta = z.infer<typeof StreamTabMetaSchema>;

/** Serialized output files on disk: Record<runId, Record<round, OutputFileInfo[]>> */
const OutputFilesRecordSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(OutputFileInfoSchema)),
);

type OutputFilesRecord = z.infer<typeof OutputFilesRecordSchema>;

/** Serialized missing outputs on disk: Record<runId, Record<round, string[]>> */
const MissingOutputsRecordSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.string())),
);

type MissingOutputsRecord = z.infer<typeof MissingOutputsRecordSchema>;

/** Serialized usage stats on disk: Record<runId, TokenUsageStats> */
const UsageStatsRecordSchema = z.record(z.string(), TokenUsageStatsSchema);

type UsageStatsRecord = z.infer<typeof UsageStatsRecordSchema>;

/** Serialized run instructions on disk: Record<runId, InstructionUpdate> */
const RunInstructionsRecordSchema = z
  .record(z.string(), InstructionUpdateSchema)
  .catch({});

type RunInstructionsRecord = z.infer<typeof RunInstructionsRecordSchema>;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Disk-backed store for a single stream tab.
 * Extends KVStore with typed accessors for each data category.
 */
class StreamTabKVStore extends KVStore {
  constructor(private readonly streamTabId: StreamTabId) {
    super(path.join(STREAM_DATA_DIR, streamTabId));
  }

  getStreamTabId(): StreamTabId {
    return this.streamTabId;
  }

  // -- Meta -----------------------------------------------------------------

  async readMeta(): Promise<StreamTabMeta | null> {
    const raw = await this.read(KEYS.META);
    if (!raw) return null;
    const result = StreamTabMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  }

  async writeMeta(meta: StreamTabMeta): Promise<void> {
    await this.write(KEYS.META, meta);
  }

  // -- Output files ---------------------------------------------------------

  async readOutputFiles(): Promise<Map<
    string,
    Map<number, OutputFileInfo[]>
  > | null> {
    const raw = await this.read(KEYS.OUTPUT_FILES);
    if (!raw) return null;
    const result = OutputFilesDataSchema.safeParse(raw);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeOutputFiles(data: OutputFilesRecord): Promise<void> {
    await this.write(KEYS.OUTPUT_FILES, data);
  }

  // -- Missing outputs ------------------------------------------------------

  async readMissingOutputs(): Promise<Map<
    string,
    Map<number, string[]>
  > | null> {
    const raw = await this.read(KEYS.MISSING_OUTPUTS);
    if (!raw) return null;
    const result = MissingOutputsDataSchema.safeParse(raw);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeMissingOutputs(data: MissingOutputsRecord): Promise<void> {
    await this.write(KEYS.MISSING_OUTPUTS, data);
  }

  // -- Usage stats ----------------------------------------------------------

  async readUsageStats(): Promise<Map<string, TokenUsageStats> | null> {
    const raw = await this.read(KEYS.USAGE_STATS);
    if (!raw) return null;
    const result = UsageDataSchema.safeParse(raw);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeUsageStats(data: UsageStatsRecord): Promise<void> {
    await this.write(KEYS.USAGE_STATS, data);
  }

  // -- Run instructions -----------------------------------------------------

  async readRunInstructions(): Promise<Map<string, InstructionUpdate> | null> {
    const raw = await this.read(KEYS.RUN_INSTRUCTIONS);
    if (!raw) return null;
    const result = RunInstructionsRecordSchema.safeParse(raw);
    if (!result.success || Object.keys(result.data).length === 0) return null;
    return new Map(Object.entries(result.data));
  }

  async writeRunInstructions(data: RunInstructionsRecord): Promise<void> {
    await this.write(KEYS.RUN_INSTRUCTIONS, data);
  }

  // -- Lifecycle ------------------------------------------------------------

  async clear(): Promise<void> {
    await this.deleteDir();
  }
}

// ============================================================================
// Factory with LRU cache
// ============================================================================

const MAX_STORE_CACHE_SIZE = 50;
const storeCache = new Map<StreamTabId, StreamTabKVStore>();

export function getStreamTabStore(streamTabId: StreamTabId): StreamTabKVStore {
  const cached = storeCache.get(streamTabId);
  if (cached) {
    // Move to end (most-recently used)
    storeCache.delete(streamTabId);
    storeCache.set(streamTabId, cached);
    return cached;
  }

  if (storeCache.size >= MAX_STORE_CACHE_SIZE) {
    const oldest = storeCache.keys().next().value;
    if (oldest !== undefined) storeCache.delete(oldest);
  }

  const store = new StreamTabKVStore(streamTabId);
  storeCache.set(streamTabId, store);
  return store;
}

/** Clear the in-memory store cache. */
export function clearStreamTabStoreCache(): void {
  storeCache.clear();
}

/** Delete all stream data from disk. */
export async function deleteAllStreamData(): Promise<void> {
  const rootKv = new KVStore(STREAM_DATA_DIR);
  await rootKv.deleteDir();
  storeCache.clear();
}

export type { StreamTabKVStore };
