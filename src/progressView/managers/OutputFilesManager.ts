/**
 * Manages output files collection with persistence.
 *
 * Internal structure: Map<StreamTabId, Map<StorageKey, OutputFileCollection>>
 * Each OutputFileCollection holds both files AND missing outputs for a single run,
 * eliminating the separate MISSING_OUTPUTS Memento key and the triple-nested Maps.
 *
 * Write-through: when the storageKey is a real ExecutionId (not "__default__"),
 * output data is also persisted to `executions/{id}/output-files.json` via
 * ExecutionKVStore, co-locating execution artifacts.
 */
import { z } from 'zod';

import {
  ExecutionIdSchema,
  type OutputFileInfo,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type MementoStorage,
} from '@progressView/persistence/PersistentMapManager';
import { createRoundMapSchema, createRunMapSchema } from '@progressView/persistence/schemaUtils';
import {
  type OutputFileCollection,
  addFiles,
  setMissing,
  getKnownPaths,
  createCollection,
  isCollectionEmpty,
  serializeCollection,
  deserializeCollection,
} from './OutputFileCollection';

// =============================================================================
// Legacy deserialization schemas (for loading old Memento data)
// =============================================================================

/** Schema for storage records with null/invalid fallback to empty object */
const StorageRecordSchema = z.record(z.string(), z.unknown()).catch({});

/** Legacy missing output paths (string arrays per round) */
const LegacyMissingRoundMapSchema = createRoundMapSchema(z.string());

/** Legacy missing outputs run map */
const LegacyMissingOutputsSchema = createRunMapSchema(LegacyMissingRoundMapSchema);

const logger = new AgentLogger('OutputFilesManager');

// =============================================================================
// Helpers
// =============================================================================

/** Check if a StorageKey is a real ExecutionId (not the __default__ sentinel). */
function isExecutionId(key: StorageKey): boolean {
  return ExecutionIdSchema.safeParse(key).success;
}

/** Write-through to ExecutionKVStore. Fire-and-forget; errors are logged, not thrown. */
function writeThrough(storageKey: StorageKey, collection: OutputFileCollection): void {
  if (!isExecutionId(storageKey)) return;

  const store = getExecutionStore(storageKey);
  store.writeOutputFiles(serializeCollection(collection)).catch((err) => {
    logger.warn(`Write-through failed for execution ${storageKey}: ${err}`);
  });
}

// =============================================================================
// Manager
// =============================================================================

export class OutputFilesManager extends PersistentMapManager<
  StreamTabId,
  Map<string, OutputFileCollection>
> {
  constructor(storage?: MementoStorage) {
    super(WorkspaceStateKey.OUTPUT_FILES, storage);
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  /**
   * Add output files for a stream and round.
   */
  async addFiles(
    stream: StreamTabId,
    storageKey: StorageKey,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): Promise<void> {
    const collection = this.getOrCreateCollection(stream, storageKey);
    addFiles(collection, filesByRound);
    writeThrough(storageKey, collection);
    await this.save();
  }

  /**
   * Update missing outputs for a stream.
   */
  async updateMissingOutputs(
    stream: StreamTabId,
    storageKey: StorageKey,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
    const collection = this.getOrCreateCollection(stream, storageKey);
    setMissing(collection, filesByRound);
    writeThrough(storageKey, collection);
    await this.save();
  }

  /** Clear missing outputs for a stream (all runs). */
  async clearMissingOutputs(stream: StreamTabId): Promise<void> {
    const runMap = this.items.get(stream);
    if (!runMap) return;

    let changed = false;
    for (const collection of runMap.values()) {
      if (collection.missing.size > 0) {
        collection.missing.clear();
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  /** Delete all files for a stream. */
  async deleteStream(stream: StreamTabId): Promise<void> {
    await super.delete(stream);
  }

  // ---------------------------------------------------------------------------
  // Read operations (public API unchanged)
  // ---------------------------------------------------------------------------

  /**
   * Get output files for a stream.
   * Returns Map<StorageKey, Map<round, OutputFileInfo[]>> for backward compatibility.
   */
  getFiles(stream: StreamTabId): Map<string, Map<number, OutputFileInfo[]>> {
    const runMap = this.items.get(stream);
    if (!runMap) return new Map();

    const result = new Map<string, Map<number, OutputFileInfo[]>>();
    for (const [key, collection] of runMap) {
      if (collection.files.size > 0) {
        result.set(key, new Map(collection.files));
      }
    }
    return result;
  }

  /**
   * Get output files for a specific run within a stream.
   */
  getRun(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Map<number, OutputFileInfo[]> | undefined {
    const collection = this.items.get(stream)?.get(storageKey);
    return collection ? new Map(collection.files) : undefined;
  }

  /**
   * Return a flattened set of file paths known for the provided stream.
   * When workspaceOnly is true, only workspace-scoped paths are returned.
   */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { storageKey?: StorageKey | null; workspaceOnly?: boolean } = {},
  ): Set<string> {
    const runMap = this.items.get(stream);
    if (!runMap) return new Set();

    const targetKeys =
      options.storageKey !== null && options.storageKey !== undefined
        ? [options.storageKey]
        : [...runMap.keys()];
    const workspaceOnly = options.workspaceOnly ?? false;

    const paths = new Set<string>();
    for (const key of targetKeys) {
      const collection = runMap.get(key);
      if (!collection) continue;
      for (const p of getKnownPaths(collection, workspaceOnly)) {
        paths.add(p);
      }
    }
    return paths;
  }

  /**
   * Get missing outputs for a stream.
   * Returns Map<StorageKey, Map<round, string[]>> for backward compatibility.
   */
  getMissingOutputs(stream: StreamTabId): Map<string, Map<number, string[]>> {
    const runMap = this.items.get(stream);
    if (!runMap) return new Map();

    const result = new Map<string, Map<number, string[]>>();
    for (const [key, collection] of runMap) {
      if (collection.missing.size > 0) {
        result.set(key, new Map(collection.missing));
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Load output files from persistence.
   * Handles migration from the legacy separate MISSING_OUTPUTS key.
   */
  async load(): Promise<void> {
    await super.load();
    await this.migrateLegacyMissingOutputs();
  }

  protected override serialize(
    value: Map<string, OutputFileCollection>,
    _key: StreamTabId,
  ): unknown {
    const record: Record<string, unknown> = {};
    for (const [runKey, collection] of value) {
      record[runKey] = serializeCollection(collection);
    }
    return record;
  }

  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<Map<string, OutputFileCollection>> {
    return deserializeRunMap(data);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getOrCreateCollection(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): OutputFileCollection {
    let runMap = this.items.get(stream);
    if (!runMap) {
      runMap = new Map();
      this.items.set(stream, runMap);
    }

    let collection = runMap.get(storageKey);
    if (!collection) {
      collection = createCollection();
      runMap.set(storageKey, collection);
    }
    return collection;
  }

  /**
   * One-time migration: merge legacy MISSING_OUTPUTS into the main data structure.
   * After merging, the legacy key is cleared.
   */
  private async migrateLegacyMissingOutputs(): Promise<void> {
    const raw = StorageRecordSchema.parse(
      this.storage.get(WorkspaceStateKey.MISSING_OUTPUTS),
    );
    if (Object.keys(raw).length === 0) return;

    let merged = false;
    for (const [stream, streamData] of Object.entries(raw)) {
      const runMap = LegacyMissingOutputsSchema.safeParse(streamData);
      if (!runMap.success) continue;

      for (const [runKey, roundMap] of runMap.data) {
        const collection = this.getOrCreateCollection(
          stream as StreamTabId,
          runKey as StorageKey,
        );
        const missingRecord: { [key: number]: string[] } = {};
        for (const [round, paths] of roundMap) {
          missingRecord[round] = paths;
        }
        setMissing(collection, missingRecord);
        merged = true;
      }
    }

    if (merged) {
      await this.save();
      await this.storage.update(
        WorkspaceStateKey.MISSING_OUTPUTS,
        undefined as never,
      );
      logger.info('Migrated legacy MISSING_OUTPUTS into OUTPUT_FILES');
    }
  }
}

// =============================================================================
// Deserialization
// =============================================================================

function deserializeRunMap(
  data: unknown,
): Map<string, OutputFileCollection> {
  if (!isPlainObject(data)) return new Map();

  const result = new Map<string, OutputFileCollection>();
  for (const [runKey, value] of Object.entries(data)) {
    if (!isPlainObject(value) && !Array.isArray(value)) continue;
    const collection = deserializeCollection(value);
    if (!isCollectionEmpty(collection)) {
      result.set(runKey, collection);
    }
  }
  return result;
}
