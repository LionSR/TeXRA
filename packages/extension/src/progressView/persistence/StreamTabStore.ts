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
 *       compileFailures.json   → round → CompileFailure[]
 *       usageStats.json        → runId → TokenUsageStats
 *
 * Legacy data shapes (from before one-run-per-tab refactor) are transparently
 * migrated on read via preprocess helpers in streamTabSchemas.ts. New workflow
 * instructions live in the log stream; this store only retains archived legacy
 * instruction records so older tabs can be backfilled during load.
 */

import * as path from 'path';
import pMap from 'p-map';

import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';

import type {
  CompileFailure,
  OutputFileInfo,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import {
  StreamTabMetaSchema,
  LegacyInstructionsDataSchema,
  OutputFilesDataSchema,
  MissingOutputsDataSchema,
  CompileFailuresDataSchema,
  UsageDataSchema,
  flattenLegacyRuns,
  isLegacyNested,
  selectPreferredLegacyInstruction,
  type LegacyInstructionEntry,
  type StreamTabMeta,
  type OutputFilesRecord,
  type MissingOutputsRecord,
  type CompileFailuresRecord,
  type UsageStatsRecord,
} from './streamTabSchemas';

// ============================================================================
// Key constants
// ============================================================================

const KEYS = {
  META: 'meta',
  OUTPUT_FILES: 'outputFiles',
  MISSING_OUTPUTS: 'missingOutputs',
  COMPILE_FAILURES: 'compileFailures',
  USAGE_STATS: 'usageStats',
  /** Legacy per-run instruction text preserved from pre-refactor memento. */
  LEGACY_INSTRUCTIONS: 'legacyInstructions',
  /** On-disk key used by the pre-refactor store; read-only fallback. */
  LEGACY_RUN_INSTRUCTIONS: 'runInstructions',
} as const;

export const STREAM_DATA_DIR = 'streamData';
const CHANNEL = 'StreamTabStore';

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

  /**
   * Per-stream-tab files are a regenerable cache: an empty/truncated JSON
   * payload (interrupted write, crash mid-flush) is functionally equivalent
   * to a missing file — the next write will replace it. Treat parse errors
   * as missing so a single corrupt file cannot block extension activation.
   * Other I/O errors still propagate so genuine failures stay loud.
   */
  private async tryRead(key: string): Promise<unknown | undefined> {
    try {
      return await this.read(key);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      logger.warn(
        CHANNEL,
        `Discarding unreadable ${key}.json for stream ${this.streamTabId}; treating as missing.`,
        { data: error },
      );
      return undefined;
    }
  }

  // -- Meta -----------------------------------------------------------------

  async readMeta(): Promise<StreamTabMeta | null> {
    const raw = await this.tryRead(KEYS.META);
    if (!raw) return null;
    const result = StreamTabMetaSchema.safeParse(raw);
    return result.success ? result.data : null;
  }

  async writeMeta(meta: StreamTabMeta): Promise<void> {
    await this.write(KEYS.META, meta);
  }

  // -- Output files ---------------------------------------------------------

  async readOutputFiles(): Promise<Map<number, OutputFileInfo[]> | null> {
    const raw = await this.tryRead(KEYS.OUTPUT_FILES);
    if (!raw) return null;
    const migrated = await this.preferActiveRunFlattening(raw);
    const result = OutputFilesDataSchema.safeParse(migrated);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeOutputFiles(data: OutputFilesRecord): Promise<void> {
    await this.write(KEYS.OUTPUT_FILES, data);
  }

  /**
   * Sole owner of legacy-record flattening. When a record is in legacy
   * nested form (`{ runId: { round: items[] } }`), prefer the run selected
   * by `meta.activeRunId` so hydration uses the run that was active when
   * the tab was last viewed. Falls back to insertion order for meta
   * without activeRunId. Already-flat records pass through unchanged, so
   * the downstream schema never needs its own preprocess step.
   */
  private async preferActiveRunFlattening(raw: unknown): Promise<unknown> {
    if (!isLegacyNested(raw)) return raw;
    const meta = await this.readMeta();
    return flattenLegacyRuns(raw, meta?.activeRunId);
  }

  // -- Missing outputs ------------------------------------------------------

  async readMissingOutputs(): Promise<Map<number, string[]> | null> {
    const raw = await this.tryRead(KEYS.MISSING_OUTPUTS);
    if (!raw) return null;
    const migrated = await this.preferActiveRunFlattening(raw);
    const result = MissingOutputsDataSchema.safeParse(migrated);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeMissingOutputs(data: MissingOutputsRecord): Promise<void> {
    await this.write(KEYS.MISSING_OUTPUTS, data);
  }

  // -- Compile failures -----------------------------------------------------

  async readCompileFailures(): Promise<Map<number, CompileFailure[]> | null> {
    const raw = await this.tryRead(KEYS.COMPILE_FAILURES);
    if (!raw) return null;
    const migrated = await this.preferActiveRunFlattening(raw);
    const result = CompileFailuresDataSchema.safeParse(migrated);
    return result.success && result.data.size > 0 ? result.data : null;
  }

  async writeCompileFailures(data: CompileFailuresRecord): Promise<void> {
    await this.write(KEYS.COMPILE_FAILURES, data);
  }

  // -- Usage stats ----------------------------------------------------------

  async readUsageStats(): Promise<Map<string, TokenUsageStats> | null> {
    const raw = await this.tryRead(KEYS.USAGE_STATS);
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
   * users don't lose the instruction text of older workflow tabs. Newer runs
   * read from the log stream; legacy runs can still be backfilled from here.
   */
  async writeLegacyInstructions(data: unknown): Promise<void> {
    await this.write(KEYS.LEGACY_INSTRUCTIONS, data);
  }

  /**
   * Read the archived legacy instruction record and pick the run users most
   * likely expect to see. Prefers `meta.activeRunId` when that migration hint
   * exists, otherwise falls back to the newest archived entry.
   */
  async readPreferredLegacyInstruction(): Promise<LegacyInstructionEntry | null> {
    const raw = await this.tryRead(KEYS.LEGACY_INSTRUCTIONS);
    if (!raw) return null;

    const result = LegacyInstructionsDataSchema.safeParse(raw);
    if (!result.success || Object.keys(result.data).length === 0) {
      return null;
    }

    const meta = await this.readMeta();
    return selectPreferredLegacyInstruction(result.data, meta?.activeRunId);
  }

  /**
   * One-time disk migration: users who already completed the earlier
   * memento→StreamTabStore migration may have `runInstructions.json` in
   * their stream directory. Move that content under `legacyInstructions`
   * so the data is preserved under the canonical archival key.
   */
  async migrateOnDiskRunInstructions(): Promise<void> {
    const existingLegacy = await this.tryRead(KEYS.LEGACY_INSTRUCTIONS);
    if (existingLegacy) return;
    const oldData = await this.tryRead(KEYS.LEGACY_RUN_INSTRUCTIONS);
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
export const STREAM_TAB_IO_CONCURRENCY = 8;
const storeCache = new Map<StreamTabId, StreamTabKVStore>();

export function mapStreamTabStorage<T>(
  streamIds: readonly StreamTabId[],
  mapper: (streamId: StreamTabId, index: number) => Promise<T> | T,
): Promise<T[]> {
  return pMap(streamIds, mapper, { concurrency: STREAM_TAB_IO_CONCURRENCY });
}

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
