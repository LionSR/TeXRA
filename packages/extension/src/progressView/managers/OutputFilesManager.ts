import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@logger';
import { RoundKeySchema } from '@progressView/persistence/streamTabSchemas';
import { mapToRecord } from '@progressView/persistence/serializationUtils';
import {
  getStreamTabStore,
  mapStreamTabStorage,
} from '@progressView/persistence/StreamTabStore';
import {
  CompileFailureSchema,
  OutputFileInfoListSchema,
  type CompileFailure,
  type OutputFileInfo,
} from '@shared/schemas/output';
import type { StreamTabId } from '@shared/schemas/identifiers';

/**
 * Manages output files per stream tab with disk-backed persistence.
 * One run per tab — files are indexed by round only, not runId.
 */
export class OutputFilesManager {
  private items: Map<StreamTabId, Map<number, OutputFileInfo[]>> = new Map();
  private _missingOutputs: Map<StreamTabId, Map<number, string[]>> = new Map();
  private _compileFailures: Map<StreamTabId, Map<number, CompileFailure[]>> =
    new Map();
  private loaded = false;
  private readonly logger: AgentTrace;
  private readonly pendingWrites = new Map<StreamTabId, Promise<void>>();
  private readonly pendingMissingWrites = new Map<StreamTabId, Promise<void>>();
  private readonly pendingCompileFailureWrites = new Map<
    StreamTabId,
    Promise<void>
  >();

  constructor() {
    this.logger = createChannelTrace('OutputFilesManager');
  }

  private getOrCreate<V>(
    map: Map<StreamTabId, Map<number, V>>,
    key: StreamTabId,
  ): Map<number, V> {
    let inner = map.get(key);
    if (!inner) {
      inner = new Map();
      map.set(key, inner);
    }
    return inner;
  }

  /** Add output files for a stream, keyed by round. */
  async addFiles(
    stream: StreamTabId,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): Promise<void> {
    const rounds = this.getOrCreate(this.items, stream);

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
        rounds.delete(roundResult.data);
        continue;
      }

      rounds.set(roundResult.data, normalizedFiles);
    }

    this.saveStream(stream);
  }

  /** Update missing outputs for a stream, keyed by round. */
  async updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
    const rounds = this.getOrCreate(this._missingOutputs, stream);

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundResult = RoundKeySchema.safeParse(round);
      if (!roundResult.success) {
        this.logger.warn(
          `Invalid missing-output round '${round}' for stream ${stream}`,
        );
        continue;
      }
      rounds.set(roundResult.data, files);
    }

    this.saveMissingOutputs(stream);
  }

  /** Update compile failures for a stream, keyed by round. */
  async updateCompileFailures(
    stream: StreamTabId,
    filesByRound: { [key: number]: CompileFailure[] },
  ): Promise<void> {
    const rounds = this.getOrCreate(this._compileFailures, stream);

    for (const [round, failures] of Object.entries(filesByRound)) {
      const roundResult = RoundKeySchema.safeParse(round);
      if (!roundResult.success) {
        this.logger.warn(
          `Invalid compile-failure round '${round}' for stream ${stream}`,
        );
        continue;
      }
      const normalizedFailures = CompileFailureSchema.array().parse(
        Array.isArray(failures) ? failures : [],
      );
      if (normalizedFailures.length === 0) {
        rounds.delete(roundResult.data);
        continue;
      }
      rounds.set(roundResult.data, normalizedFailures);
    }

    this.saveCompileFailures(stream);
  }

  /** Get output files for a stream (copy). */
  getFiles(stream: StreamTabId): Map<number, OutputFileInfo[]> {
    return new Map(this.items.get(stream) ?? []);
  }

  /**
   * Return a flattened set of file paths known for the provided stream.
   */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { workspaceOnly?: boolean } = {},
  ): Set<string> {
    const paths = new Set<string>();
    const rounds = this.items.get(stream);
    if (!rounds) return paths;

    const workspaceOnly = options.workspaceOnly ?? false;

    for (const infos of rounds.values()) {
      for (const info of infos) {
        this.collectPaths(paths, info, workspaceOnly);
      }
    }
    return paths;
  }

  private collectPaths(
    target: Set<string>,
    info: OutputFileInfo,
    workspaceOnly: boolean,
  ): void {
    const loc = info.location;
    if (!workspaceOnly || loc.kind === 'workspace') {
      target.add(loc.absolutePath);
    }
  }

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): Map<number, string[]> {
    if (!this.loaded) {
      throw new Error('Missing outputs requested before load completed');
    }
    return new Map(this._missingOutputs.get(stream) ?? []);
  }

  /** Get compile failures for a stream */
  getCompileFailures(stream: StreamTabId): Map<number, CompileFailure[]> {
    return new Map(this._compileFailures.get(stream) ?? []);
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
    this._compileFailures.delete(stream);
    this.pendingWrites.delete(stream);
    this.pendingMissingWrites.delete(stream);
    this.pendingCompileFailureWrites.delete(stream);
  }

  /** Clear all in-memory state. Disk cleanup owned by caller. */
  evictAll(): void {
    this.items.clear();
    this._missingOutputs.clear();
    this._compileFailures.clear();
    this.pendingWrites.clear();
    this.pendingMissingWrites.clear();
    this.pendingCompileFailureWrites.clear();
  }

  /** Load output files from disk-backed StreamTabStore */
  async load(streamIds: StreamTabId[]): Promise<void> {
    this.items.clear();
    this._missingOutputs.clear();
    this._compileFailures.clear();

    await mapStreamTabStorage(streamIds, async (streamId) => {
      const store = getStreamTabStore(streamId);
      const [outputFiles, missingOutputs, compileFailures] = await Promise.all([
        store.readOutputFiles(),
        store.readMissingOutputs(),
        store.readCompileFailures(),
      ]);
      if (outputFiles?.size) {
        this.items.set(streamId, outputFiles);
      }
      if (missingOutputs?.size) {
        this._missingOutputs.set(streamId, missingOutputs);
      }
      if (compileFailures?.size) {
        this._compileFailures.set(streamId, compileFailures);
      }
    });

    this.loaded = true;
  }

  /** Await all pending disk writes. */
  async flush(): Promise<void> {
    await Promise.all([
      ...this.pendingWrites.values(),
      ...this.pendingMissingWrites.values(),
      ...this.pendingCompileFailureWrites.values(),
    ]);
  }

  // -- Per-stream persistence -----------------------------------------------

  private saveStream(stream: StreamTabId): void {
    this.chainWrite(stream, this.pendingWrites, () => {
      const data = this.items.get(stream);
      return getStreamTabStore(stream).writeOutputFiles(
        data ? mapToRecord(data) : {},
      );
    });
  }

  private saveMissingOutputs(stream: StreamTabId): void {
    this.chainWrite(stream, this.pendingMissingWrites, () => {
      const data = this._missingOutputs.get(stream);
      return getStreamTabStore(stream).writeMissingOutputs(
        data ? mapToRecord(data) : {},
      );
    });
  }

  private saveCompileFailures(stream: StreamTabId): void {
    this.chainWrite(stream, this.pendingCompileFailureWrites, () => {
      const data = this._compileFailures.get(stream);
      return getStreamTabStore(stream).writeCompileFailures(
        data ? mapToRecord(data) : {},
      );
    });
  }

  private chainWrite(
    stream: StreamTabId,
    writesMap: Map<StreamTabId, Promise<void>>,
    write: () => Promise<void> | void,
  ): void {
    if (!this.loaded) return;
    const prev = writesMap.get(stream) ?? Promise.resolve();
    const next = prev.then(() => {
      if (!writesMap.has(stream)) return;
      return write();
    });
    writesMap.set(
      stream,
      next.catch(() => {}),
    );
  }
}
