import * as vscode from 'vscode';
import { z } from 'zod';

import {
  OutputFileInfoListSchema,
  OutputFileInfoSchema,
  type OutputFileInfo,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { normalizeRunId } from '@common/constants/runIds';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type MementoStorage,
} from '@progressView/persistence/PersistentMapManager';
import {
  RoundKeySchema,
  createRoundMapSchema,
  createRunMapSchema,
} from '@progressView/persistence/schemaUtils';
import {
  nestedMapToRecord,
  tripleNestedMapToRecord,
} from '@progressView/persistence/serializationUtils';

/** Schema for storage records with null/invalid fallback to empty object */
const StorageRecordSchema = z.record(z.string(), z.unknown()).catch({});

/** Schema for missing output paths (string arrays per round) */
const MissingOutputRoundMapSchema = createRoundMapSchema(z.string());

/** Schema for output files round map (filters invalid entries during parsing) */
const OutputFilesRoundMapSchema = z
  .record(z.string(), z.array(z.unknown()).catch([]))
  .transform((record): Map<number, OutputFileInfo[]> => {
    const map = new Map<number, OutputFileInfo[]>();
    for (const [key, items] of Object.entries(record)) {
      const round = RoundKeySchema.safeParse(key);
      if (!round.success) continue;
      const parsed = items
        .map((item) => OutputFileInfoSchema.safeParse(item))
        .filter(
          (result): result is { success: true; data: OutputFileInfo } =>
            result.success,
        )
        .map((result) => result.data);
      if (parsed.length > 0) {
        map.set(round.data, parsed);
      }
    }
    return map;
  });

/** Schema for missing outputs run map */
const MissingOutputsDataSchema = createRunMapSchema(
  MissingOutputRoundMapSchema,
);

/** Schema for output files run map */
const OutputFilesDataSchema = createRunMapSchema(OutputFilesRoundMapSchema);

/**
 * Manages output files collection with persistence and file existence validation.
 * Handles adding, updating, and managing output files for different streams.
 */
export class OutputFilesManager extends PersistentMapManager<
  StreamTabId,
  Map<string, Map<number, OutputFileInfo[]>>
> {
  private _missingOutputs: Map<
    StreamTabId,
    Map<string, Map<number, string[]>>
  > = new Map();
  private missingOutputsLoaded = false;
  private missingOutputsLoadPromise: Promise<void> | null = null;
  private readonly logger: AgentLogger;

  constructor(storage?: MementoStorage) {
    super(WorkspaceStateKey.OUTPUT_FILES, storage);
    this.logger = new AgentLogger('OutputFilesManager');
  }

  /** Get or create a nested map entry */
  private getOrCreateNested<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
    let inner = map.get(key);
    if (!inner) {
      inner = factory();
      map.set(key, inner);
    }
    return inner;
  }

  /**
   * Add output files for a stream and round.
   *
   * @param stream - The stream tab ID
   * @param storageKey - THE key for storage (single source of truth)
   * @param filesByRound - Map of round number to output files
   */
  async addFiles(
    stream: StreamTabId,
    storageKey: StorageKey,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): Promise<void> {
    // storageKey is already branded - use directly, no normalization needed
    const streamRuns = this.getOrCreateNested(
      this.items,
      stream,
      () => new Map(),
    );
    const runRounds = this.getOrCreateNested(
      streamRuns,
      storageKey,
      () => new Map(),
    );

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundResult = RoundKeySchema.safeParse(round);
      if (!roundResult.success) {
        this.logger.warn(
          `Invalid round number '${round}' for stream ${stream}`,
        );
        continue;
      }
      const normalizedFiles = OutputFileInfoListSchema.parse(
        Array.isArray(files) ? files : [],
      );
      if (normalizedFiles.length === 0) {
        runRounds.delete(roundResult.data);
        continue;
      }

      runRounds.set(roundResult.data, normalizedFiles);
    }

    await this.save();
  }

  /**
   * Update missing outputs for a stream.
   *
   * @param stream - The stream tab ID
   * @param storageKey - THE key for storage (single source of truth)
   * @param filesByRound - Map of round number to missing file paths
   */
  async updateMissingOutputs(
    stream: StreamTabId,
    storageKey: StorageKey,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
    await this.ensureMissingOutputsLoaded();
    // storageKey is already branded - use directly, no normalization needed
    const streamMissing = this.getOrCreateNested(
      this._missingOutputs,
      stream,
      () => new Map(),
    );
    const runMissing = this.getOrCreateNested(
      streamMissing,
      storageKey,
      () => new Map(),
    );

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundResult = RoundKeySchema.safeParse(round);
      if (!roundResult.success) {
        this.logger.warn(
          `Invalid missing-output round '${round}' for stream ${stream}`,
        );
        continue;
      }
      runMissing.set(roundResult.data, files);
    }

    await this.saveMissingOutputs();
  }

  /** Get output files for a stream */
  getFiles(stream: StreamTabId): Map<string, Map<number, OutputFileInfo[]>> {
    return new Map(this.items.get(stream) ?? []);
  }

  getRun(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Map<number, OutputFileInfo[]> | undefined {
    const target = this.items.get(stream)?.get(storageKey);
    // Return a copy to prevent external mutation
    return target ? new Map(target) : undefined;
  }

  /**
   * Return a flattened set of file paths known for the provided stream.
   * When workspaceOnly is true, only workspace-scoped paths are returned so
   * commands like pack/clean do not accidentally target run-storage artifacts.
   *
   * @param stream - The stream tab ID
   * @param options.storageKey - THE key for storage lookup
   * @param options.workspaceOnly - If true, only returns workspace-scoped paths
   */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { storageKey?: StorageKey | null; workspaceOnly?: boolean } = {},
  ): Set<string> {
    const paths = new Set<string>();
    const runs = this.items.get(stream);
    if (!runs) return paths;

    const targetRunIds =
      options.storageKey !== null && options.storageKey !== undefined
        ? [options.storageKey]
        : [...runs.keys()];
    const workspaceOnly = options.workspaceOnly ?? false;

    for (const target of targetRunIds) {
      const runRounds = runs.get(target);
      if (!runRounds) continue;

      for (const infos of runRounds.values()) {
        for (const info of infos) {
          this.collectPaths(paths, info, workspaceOnly);
        }
      }
    }
    return paths;
  }

  /**
   * Collect paths from an output file info.
   * @param target - Set to add paths to
   * @param info - Output file info containing location and lineage
   * @param workspaceOnly - If true, only collect workspace-scoped paths
   */
  private collectPaths(
    target: Set<string>,
    info: OutputFileInfo,
    workspaceOnly: boolean,
  ): void {
    const { lineage } = info;
    const locations = [
      info.location,
      lineage?.original,
      lineage?.diffBase,
      lineage?.diffFile,
    ];

    for (const loc of locations) {
      if (loc?.absolutePath && (!workspaceOnly || loc.kind === 'workspace')) {
        target.add(loc.absolutePath);
      }
    }
  }

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): Map<string, Map<number, string[]>> {
    if (!this.missingOutputsLoaded) {
      throw new Error('Missing outputs requested before load completed');
    }
    const missing = this._missingOutputs.get(stream);
    return missing ? new Map(missing) : new Map();
  }

  /** Clear missing outputs for a stream */
  async clearMissingOutputs(stream: StreamTabId): Promise<void> {
    await this.ensureMissingOutputsLoaded();
    if (!this._missingOutputs.delete(stream)) {
      return;
    }
    await this.saveMissingOutputs();
  }

  /** Delete all files for a stream */
  async deleteStream(stream: StreamTabId): Promise<void> {
    await super.delete(stream);
    await this.ensureMissingOutputsLoaded();
    this._missingOutputs.delete(stream);
    await this.saveMissingOutputs();
  }

  /** Clear all output files */
  async clear(): Promise<void> {
    await super.clear();
    await this.ensureMissingOutputsLoaded();
    this._missingOutputs.clear();
    await this.saveMissingOutputs();
  }

  /** Load output files from persistence and clean up missing files */
  async load(): Promise<void> {
    await super.load();
    await this.ensureMissingOutputsLoaded();
  }

  /** Load missing outputs from persistence */
  private async loadMissingOutputs(): Promise<void> {
    const saved = this.loadStorageRecord(WorkspaceStateKey.MISSING_OUTPUTS);
    if (Object.keys(saved).length > 0) {
      this._missingOutputs = this.deserializeMissingOutputs(saved);
      return;
    }

    const migrated = await this.migrateLegacyMissingOutputs();
    if (!migrated) {
      this._missingOutputs.clear();
    }
  }

  private async ensureMissingOutputsLoaded(): Promise<void> {
    if (this.missingOutputsLoaded) return;

    if (!this.missingOutputsLoadPromise) {
      this.missingOutputsLoadPromise = (async () => {
        try {
          await this.loadMissingOutputs();
          this.missingOutputsLoaded = true;
        } catch (error) {
          this.logger.error('Failed to load missing outputs', { data: error });
          this.missingOutputsLoadPromise = null;
          throw error;
        }
      })();
    }

    await this.missingOutputsLoadPromise;
  }

  /** Save missing outputs to persistence */
  async saveMissingOutputs(): Promise<void> {
    const obj = tripleNestedMapToRecord(this._missingOutputs);
    await this.storage.update(WorkspaceStateKey.MISSING_OUTPUTS, obj);
  }

  private deserializeMissingOutputs(
    saved: Record<string, unknown>,
  ): Map<StreamTabId, Map<string, Map<number, string[]>>> {
    const processed = new Map<
      StreamTabId,
      Map<string, Map<number, string[]>>
    >();

    for (const [stream, raw] of Object.entries(saved)) {
      const runMap = MissingOutputsDataSchema.parse(raw);
      processed.set(stream as StreamTabId, runMap);
    }

    return processed;
  }

  private async migrateLegacyMissingOutputs(): Promise<boolean> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      return false;
    }

    const legacyKey = `${WorkspaceStateKey.MISSING_OUTPUTS}.${workspacePath}`;
    const legacy = this.loadStorageRecord(legacyKey);
    if (Object.keys(legacy).length === 0) {
      return false;
    }

    const converted: Record<
      string,
      Record<string, { [key: number]: string[] }>
    > = {};

    for (const [stream, rounds] of Object.entries(legacy)) {
      converted[stream] = {
        [normalizeRunId(null)]: rounds as { [key: number]: string[] },
      };
    }

    this._missingOutputs = this.deserializeMissingOutputs(converted);
    await this.saveMissingOutputs();
    await this.storage.update(legacyKey, undefined as never);
    return true;
  }

  /** Load record from storage with null/invalid fallback */
  private loadStorageRecord(key: string): Record<string, unknown> {
    return StorageRecordSchema.parse(this.storage.get(key));
  }

  protected override serialize(
    value: Map<string, Map<number, OutputFileInfo[]>>,
    _key: StreamTabId,
  ): unknown {
    return nestedMapToRecord(value);
  }

  /** Validate and normalize loaded output files */
  protected override async deserialize(
    data: unknown,
    _key: StreamTabId,
  ): Promise<Map<string, Map<number, OutputFileInfo[]>>> {
    return OutputFilesDataSchema.parse(data);
  }
}
