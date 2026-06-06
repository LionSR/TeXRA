/**
 * Legacy per-run-instruction reader for `streamData/{id}/`.
 *
 * `StreamSnapshotStore` (`@transcript`) is the single owner of `streamData/`:
 * it reads, writes, and deletes every live per-stream sidecar file. This module
 * survives only for one residual legacy concern — archival per-run instruction
 * records (`legacyInstructions.json` / older `runInstructions.json`), read
 * during load so workflow tabs created before the one-run-per-tab refactor
 * (#3061, Apr 2026) can still backfill their original instruction into the log
 * stream. It can be retired entirely once those pre-#3061 tabs age out.
 */

import * as path from 'path';
import pMap from 'p-map';

import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import { STREAM_DATA_DIR, encodeStreamId } from '@transcript/streamDataPaths';

import {
  StreamTabMetaSchema,
  LegacyInstructionsDataSchema,
  selectPreferredLegacyInstruction,
  type StreamTabId,
  type LegacyInstructionEntry,
  type StreamTabMeta,
} from '@shared/schemas';

// ============================================================================
// Key constants
// ============================================================================

const KEYS = {
  META: 'meta',
  /** Legacy per-run instruction text preserved from pre-refactor memento. */
  LEGACY_INSTRUCTIONS: 'legacyInstructions',
  /** On-disk key used by the pre-refactor store; read-only fallback. */
  LEGACY_RUN_INSTRUCTIONS: 'runInstructions',
} as const;

const CHANNEL = 'StreamTabStore';

// ============================================================================
// Implementation
// ============================================================================

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

  // -- Legacy per-run instructions (preserved from pre-refactor memento) ---

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

export type { StreamTabKVStore };
