import {
  OutputFileInfoListSchema,
  type OutputFileInfo,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { AgentLogger } from '@logger/AgentLogger';
import { RoundKeySchema } from '@progressView/persistence/streamTabSchemas';
import { nestedMapToRecord } from '@progressView/persistence/serializationUtils';
import { getStreamTabStore } from '@progressView/persistence/StreamTabStore';

/**
 * Manages output files collection with disk-backed persistence per stream tab.
 * Each stream's data lives in its own directory on disk via StreamTabStore.
 *
 * Disk writes happen per-stream on mutation. Disk deletion is owned by
 * ProgressViewState (via store.clear() / deleteAllStreamData()).
 */
export class OutputFilesManager {
  private items: Map<StreamTabId, Map<string, Map<number, OutputFileInfo[]>>> =
    new Map();
  private _missingOutputs: Map<
    StreamTabId,
    Map<string, Map<number, string[]>>
  > = new Map();
  private loaded = false;
  private readonly logger: AgentLogger;
  private readonly pendingWrites = new Map<StreamTabId, Promise<void>>();
  private readonly pendingMissingWrites = new Map<StreamTabId, Promise<void>>();

  constructor() {
    this.logger = new AgentLogger('OutputFilesManager');
  }

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
   */
  async addFiles(
    stream: StreamTabId,
    storageKey: StorageKey,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): Promise<void> {
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

    this.saveStream(stream);
  }

  /**
   * Update missing outputs for a stream.
   */
  async updateMissingOutputs(
    stream: StreamTabId,
    storageKey: StorageKey,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
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

    this.saveMissingOutputs(stream);
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
    return target ? new Map(target) : undefined;
  }

  /**
   * Return a flattened set of file paths known for the provided stream.
   */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { storageKey?: StorageKey | null; workspaceOnly?: boolean } = {},
  ): Set<string> {
    const paths = new Set<string>();
    const runs = this.items.get(stream);
    if (!runs) return paths;

    const targetRunIds =
      options.storageKey != null ? [options.storageKey] : [...runs.keys()];
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
    if (!this.loaded) {
      throw new Error('Missing outputs requested before load completed');
    }
    const missing = this._missingOutputs.get(stream);
    return missing ? new Map(missing) : new Map();
  }

  /** Clear missing outputs for a stream (in-memory + disk) */
  async clearMissingOutputs(stream: StreamTabId): Promise<void> {
    if (!this._missingOutputs.delete(stream)) {
      return;
    }
    this.saveMissingOutputs(stream);
  }

  /** Remove a stream from in-memory state. Disk cleanup owned by caller. */
  evict(stream: StreamTabId): void {
    this.items.delete(stream);
    this._missingOutputs.delete(stream);
    this.pendingWrites.delete(stream);
    this.pendingMissingWrites.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.items.clear();
    this._missingOutputs.clear();
    this.pendingWrites.clear();
    this.pendingMissingWrites.clear();
  }

  /** Load output files from disk-backed StreamTabStore */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.items.clear();
    this._missingOutputs.clear();

    await Promise.all(
      streamIds.map(async (streamId) => {
        const store = getStreamTabStore(streamId);
        const [outputFiles, missingOutputs] = await Promise.all([
          store.readOutputFiles(),
          store.readMissingOutputs(),
        ]);
        if (outputFiles && outputFiles.size > 0) {
          this.items.set(streamId, outputFiles);
        }
        if (missingOutputs && missingOutputs.size > 0) {
          this._missingOutputs.set(streamId, missingOutputs);
        }
      }),
    );

    this.loaded = true;
  }

  /** Await all pending disk writes. */
  async flush(): Promise<void> {
    await Promise.all([
      ...this.pendingWrites.values(),
      ...this.pendingMissingWrites.values(),
    ]);
  }

  // -- Per-stream persistence -----------------------------------------------

  private saveStream(stream: StreamTabId): void {
    if (!this.loaded) return;
    const prev = this.pendingWrites.get(stream) ?? Promise.resolve();
    const next = prev.then(() => {
      if (!this.pendingWrites.has(stream)) return;
      const data = this.items.get(stream);
      const store = getStreamTabStore(stream);
      return store.writeOutputFiles(data ? nestedMapToRecord(data) : {});
    });
    this.pendingWrites.set(
      stream,
      next.catch(() => {}),
    );
  }

  private saveMissingOutputs(stream: StreamTabId): void {
    if (!this.loaded) return;
    const prev = this.pendingMissingWrites.get(stream) ?? Promise.resolve();
    const next = prev.then(() => {
      if (!this.pendingMissingWrites.has(stream)) return;
      const data = this._missingOutputs.get(stream);
      const store = getStreamTabStore(stream);
      return store.writeMissingOutputs(data ? nestedMapToRecord(data) : {});
    });
    this.pendingMissingWrites.set(
      stream,
      next.catch(() => {}),
    );
  }
}
