/**
 * Per-stream-tab disk-backed storage.
 *
 * Each stream tab gets its own directory under `streamData/`:
 *
 *   streamData/
 *     {encoded(streamTabId)}/
 *       meta.json              → StreamTabMeta
 *       outputFiles.json       → round → OutputFileInfo[]
 *       missingOutputs.json    → round → string[]
 *       usageStats.json        → runId → TokenUsageStats
 *
 * Legacy data shapes (from before one-run-per-tab refactor) are transparently
 * migrated on read via preprocess helpers in streamTabSchemas.ts.
 * Instructions are rendered as user-message log entries now, so they are
 * stored in the log stream, not in this store.
 */

import * as path from 'path';

import { KVStore } from '@common/storage';

import type {
  OutputFileInfo,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import {
  StreamTabMetaSchema,
  OutputFilesDataSchema,
  MissingOutputsDataSchema,
  UsageDataSchema,
  flattenLegacyRuns,
  isLegacyNested,
  type StreamTabMeta,
  type OutputFilesRecord,
  type MissingOutputsRecord,
  type UsageStatsRecord,
} from './streamTabSchemas';

// ============================================================================
// Key constants
// ============================================================================

const KEYS = {
  META: 'meta',
  OUTPUT_FILES: 'outputFiles',
  MISSING_OUTPUTS: 'missingOutputs',
  USAGE_STATS: 'usageStats',
  /** Legacy per-run instruction text preserved from pre-refactor memento. */
  LEGACY_INSTRUCTIONS: 'legacyInstructions',
  /** On-disk key used by the pre-refactor store; read-only fallback. */
  LEGACY_RUN_INSTRUCTIONS: 'runInstructions',
} as const;

export const STREAM_DATA_DIR = 'streamData';

// ============================================================================
// Implementation
// ============================================================================

/**
 * Encode a stream tab ID for safe use as a filesystem directory name.
 * Stream IDs can contain `:`, `/`, `#`, and other unsafe characters.
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

  async readOutputFiles(): Promise<Map<number, OutputFileInfo[]> | null> {
    const raw = await this.read(KEYS.OUTPUT_FILES);
    if (!raw) return null;
    const migrated = await this.preferActiveRunFlattening(raw);
    const result = OutputFilesDataSchema.safeParse(migrated);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeOutputFiles(data: OutputFilesRecord): Promise<void> {
    await this.write(KEYS.OUTPUT_FILES, data);
  }

  /**
   * When a record is in legacy nested form (`{ runId: { round: items[] } }`),
   * prefer the run selected by `meta.activeRunId` so hydration uses the run
   * that was active when the tab was last viewed. Falls back to insertion
   * order for meta without activeRunId or for already-flat records.
   */
  private async preferActiveRunFlattening(raw: unknown): Promise<unknown> {
    if (!isLegacyNested(raw)) return raw;
    const meta = await this.readMeta();
    return flattenLegacyRuns(raw, meta?.activeRunId);
  }

  // -- Missing outputs ------------------------------------------------------

  async readMissingOutputs(): Promise<Map<number, string[]> | null> {
    const raw = await this.read(KEYS.MISSING_OUTPUTS);
    if (!raw) return null;
    const migrated = await this.preferActiveRunFlattening(raw);
    const result = MissingOutputsDataSchema.safeParse(migrated);
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

  // -- Legacy per-run instructions (preserved from pre-refactor memento) ---

  /**
   * Persist legacy `{ runId: InstructionUpdate }` data verbatim so migrated
   * users don't lose the instruction text of older workflow tabs. The new
   * UI logs instructions as user-message entries at run start, so this
   * file is write-only here — readers must inspect it manually on disk.
   */
  async writeLegacyInstructions(data: unknown): Promise<void> {
    await this.write(KEYS.LEGACY_INSTRUCTIONS, data);
  }

  /**
   * One-time disk migration: users who already completed the earlier
   * memento→StreamTabStore migration may have `runInstructions.json` in
   * their stream directory. Move that content under `legacyInstructions`
   * so the data is preserved under the canonical archival key.
   */
  async migrateOnDiskRunInstructions(): Promise<void> {
    const existingLegacy = await this.read(KEYS.LEGACY_INSTRUCTIONS);
    if (existingLegacy) return;
    const oldData = await this.read(KEYS.LEGACY_RUN_INSTRUCTIONS);
    if (!oldData) return;
    await this.write(KEYS.LEGACY_INSTRUCTIONS, oldData);
    await this.delete(KEYS.LEGACY_RUN_INSTRUCTIONS);
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
