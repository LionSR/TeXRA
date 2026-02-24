/**
 * Per-stream-tab disk-backed storage.
 *
 * Each stream tab gets its own directory under `streamData/`:
 *
 *   streamData/
 *     {encoded(streamTabId)}/
 *       meta.json              → StreamTabMeta
 *       outputFiles.json       → run → round → OutputFileInfo[]
 *       missingOutputs.json    → run → round → string[]
 *       usageStats.json        → run → TokenUsageStats
 *       runInstructions.json   → run → InstructionUpdate
 *
 * Follows the ExecutionKVStore pattern: KVStore per entity, typed accessors
 * with Zod validation, LRU cache of store instances.
 *
 * All schemas live in streamTabSchemas.ts (single source of truth).
 * This file is pure infrastructure: KV operations + typed accessors + cache.
 */

import * as path from 'path';

import type {
  InstructionUpdate,
  OutputFileInfo,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import { KVStore } from '@common/storage';

import {
  StreamTabMetaSchema,
  OutputFilesDataSchema,
  MissingOutputsDataSchema,
  UsageDataSchema,
  RunInstructionsRecordSchema,
  type StreamTabMeta,
  type OutputFilesRecord,
  type MissingOutputsRecord,
  type UsageStatsRecord,
  type RunInstructionsRecord,
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
// Implementation
// ============================================================================

/**
 * Encode a stream tab ID for safe use as a filesystem directory name.
 * Stream IDs can contain `:`, `/`, and other unsafe characters
 * (e.g. `agent@model: path/to/file.tex`).
 */
function encodeStreamId(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Disk-backed store for a single stream tab.
 * Extends KVStore with typed accessors for each data category.
 */
class StreamTabKVStore extends KVStore {
  constructor(private readonly streamTabId: StreamTabId) {
    super(path.join(STREAM_DATA_DIR, encodeStreamId(streamTabId)));
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

export async function deleteAllStreamData(): Promise<void> {
  const rootKv = new KVStore(STREAM_DATA_DIR);
  await rootKv.deleteDir();
  storeCache.clear();
}

export type { StreamTabKVStore };
