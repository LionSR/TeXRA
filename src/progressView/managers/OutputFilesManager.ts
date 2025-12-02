// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - progress view
import type { StorageKey, StreamTabId } from '@agent/types/IdentifierTypes';
// Internal imports
import {
  OutputFileInfoListSchema,
  OutputFileInfoSchema,
  type OutputFileInfo,
} from '@agent/output/types';
import { normalizeRunId } from '@common/constants/runIds';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import {
  PersistentMapManager,
  type StateStorage,
} from '@progressView/persistence/PersistentMapManager';

// --- Zod Schemas for Output Files ---

/** Schema for integer round keys (coerces string keys to numbers) */
const RoundKey = z.coerce.number().int();

/** Schema for a round map: { roundNumber: items[] } -> Map<number, T[]> */
function createRoundMapSchema<T>(itemSchema: z.ZodType<T>) {
  return z
    .record(z.string(), z.array(itemSchema).catch([]))
    .transform((record): Map<number, T[]> => {
      const map = new Map<number, T[]>();
      for (const [key, items] of Object.entries(record)) {
        const round = RoundKey.safeParse(key);
        if (round.success && items.length > 0) {
          map.set(round.data, items);
        }
      }
      return map;
    });
}

/** Schema for missing output paths (string arrays per round) */
const MissingOutputRoundMapSchema = createRoundMapSchema(z.string());

/** Schema for output files round map (filters invalid entries during parsing) */
const OutputFilesRoundMapSchema = z
  .record(z.string(), z.array(z.unknown()).catch([]))
  .transform((record): Map<number, OutputFileInfo[]> => {
    const map = new Map<number, OutputFileInfo[]>();
    for (const [key, items] of Object.entries(record)) {
      const round = RoundKey.safeParse(key);
      if (!round.success) continue;
      const parsed = items
        .map((item) => OutputFileInfoSchema.safeParse(item))
        .filter((result): result is z.SafeParseSuccess<OutputFileInfo> => result.success)
        .map((result) => result.data);
      if (parsed.length > 0) {
        map.set(round.data, parsed);
      }
    }
    return map;
  });

/**
 * Detects if a record looks like legacy format (all keys are numeric)
 * vs modern format (keys are run IDs like strings)
 */
function isLegacyFormat(record: Record<string, unknown>): boolean {
  const entries = Object.entries(record);
  return entries.length > 0 && entries.every(
    ([key]) => !Number.isNaN(Number.parseInt(key, 10)),
  );
}

/**
 * Factory for creating schemas that handle both legacy and modern run map formats.
 * Legacy: { roundNum: items[] } -> wrapped in default run ID
 * Modern: { runId: { roundNum: items[] } }
 */
function createLegacyAwareRunMapSchema<T>(
  roundMapSchema: z.ZodType<Map<number, T[]>>,
) {
  return z.unknown().transform((data): Map<string, Map<number, T[]>> => {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const record = data as Record<string, unknown>;
    if (isLegacyFormat(record)) {
      const rounds = roundMapSchema.parse(record);
      return rounds.size > 0
        ? new Map([[normalizeRunId(null), rounds]])
        : new Map();
    }

    const runMap = new Map<string, Map<number, T[]>>();
    for (const [runId, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') continue;
      const rounds = roundMapSchema.parse(value);
      if (rounds.size > 0) {
        runMap.set(runId, rounds);
      }
    }
    return runMap;
  });
}

/** Schema for missing outputs with legacy format support */
const MissingOutputsDataSchema = createLegacyAwareRunMapSchema(MissingOutputRoundMapSchema);

/** Schema for output files with legacy format support */
const OutputFilesDataSchema = createLegacyAwareRunMapSchema(OutputFilesRoundMapSchema);

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

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.OUTPUT_FILES, storage);
    this.logger = new AgentLogger('OutputFilesManager');
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
    let streamRuns = this.items.get(stream);
    if (!streamRuns) {
      streamRuns = new Map();
      this.items.set(stream, streamRuns);
    }

    let runRounds = streamRuns.get(storageKey);
    if (!runRounds) {
      runRounds = new Map();
      streamRuns.set(storageKey, runRounds);
    }

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = Number.parseInt(round, 10);
      if (Number.isNaN(roundNum)) {
        this.logger.warn(
          `Invalid round number '${round}' for stream ${stream}`,
        );
        continue;
      }
      const normalizedFiles = OutputFileInfoListSchema.parse(
        Array.isArray(files) ? files : [],
      );
      if (normalizedFiles.length === 0) {
        runRounds.delete(roundNum);
        continue;
      }

      runRounds.set(roundNum, normalizedFiles);
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

    let streamMissing = this._missingOutputs.get(stream);
    if (!streamMissing) {
      streamMissing = new Map();
      this._missingOutputs.set(stream, streamMissing);
    }

    let runMissing = streamMissing.get(storageKey);
    if (!runMissing) {
      runMissing = new Map();
      streamMissing.set(storageKey, runMissing);
    }

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = Number.parseInt(round, 10);
      if (Number.isNaN(roundNum)) {
        this.logger.warn(
          `Invalid missing-output round '${round}' for stream ${stream}`,
        );
        continue;
      }
      runMissing.set(roundNum, files);
    }

    await this.saveMissingOutputs();
  }

  /** Get output files for a stream */
  getFiles(stream: StreamTabId): Map<string, Map<number, OutputFileInfo[]>> {
    const runs = this.items.get(stream);
    return runs ? new Map(runs) : new Map();
  }

  getRun(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Map<number, OutputFileInfo[]> | undefined {
    const runs = this.items.get(stream);
    if (!runs) {
      return undefined;
    }

    const target = runs.get(storageKey);
    if (!target) {
      return undefined;
    }

    const entries: [number, OutputFileInfo[]][] = [];
    for (const [round, infos] of target.entries()) {
      if (Array.isArray(infos)) {
        entries.push([round, infos]);
      }
    }

    return new Map(entries);
  }

  getRunMissingOutputs(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Map<number, string[]> | undefined {
    if (!this.missingOutputsLoaded) {
      throw new Error('Missing outputs requested before load completed');
    }

    const runs = this._missingOutputs.get(stream);
    if (!runs) {
      return undefined;
    }

    const target = runs.get(storageKey);
    if (!target) {
      return undefined;
    }

    return new Map(target);
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
    if (!runs) {
      return paths;
    }

    // storageKey is THE single source of truth
    const targetRunIds =
      options.storageKey !== undefined && options.storageKey !== null
        ? [options.storageKey]
        : Array.from(runs.keys());

    for (const target of targetRunIds) {
      const runRounds = runs.get(target);
      if (!runRounds) {
        continue;
      }

      for (const infos of runRounds.values()) {
        for (const info of infos) {
          if (options.workspaceOnly) {
            this.collectWorkspacePaths(paths, info);
          } else {
            this.collectAllPaths(paths, info);
          }
        }
      }
    }

    return paths;
  }

  /**
   * Collect all paths from an output file info (absolute paths).
   */
  private collectAllPaths(target: Set<string>, info: OutputFileInfo): void {
    target.add(info.location.absolutePath);
    if (info.lineage?.original?.absolutePath) {
      target.add(info.lineage.original.absolutePath);
    }
  }

  /**
   * Collect workspace paths from an output file info.
   * Trust the discriminated union - the 'kind' field is the source of truth.
   */
  private collectWorkspacePaths(
    target: Set<string>,
    info: OutputFileInfo,
  ): void {
    // Current file
    if (info.location.kind === 'workspace') {
      target.add(info.location.absolutePath);
    }

    // Lineage files (NEW STRUCTURE: original, diffBase, diffFile)
    if (info.lineage?.original?.kind === 'workspace') {
      target.add(info.lineage.original.absolutePath);
    }
    if (info.lineage?.diffBase?.kind === 'workspace') {
      target.add(info.lineage.diffBase.absolutePath);
    }
    if (info.lineage?.diffFile?.kind === 'workspace') {
      target.add(info.lineage.diffFile.absolutePath);
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

  /** Clear output files for a stream */
  async clearFiles(stream: StreamTabId): Promise<void> {
    await this.delete(stream);
  }

  /**
   * Clear output files for a specific run within a stream.
   *
   * @param stream - The stream tab ID
   * @param storageKey - THE key for storage operations
   */
  async clearRunFiles(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Promise<void> {
    const runs = this.items.get(stream);
    if (!runs) {
      return;
    }

    const removed = runs.delete(storageKey);
    if (runs.size === 0) {
      this.items.delete(stream);
    }

    if (removed) {
      await this.save();
    }
  }

  /** Clear missing outputs for a stream */
  async clearMissingOutputs(stream: StreamTabId): Promise<void> {
    await this.ensureMissingOutputsLoaded();
    if (!this._missingOutputs.delete(stream)) {
      return;
    }
    await this.saveMissingOutputs();
  }

  /**
   * Clear missing output records for a specific run within a stream.
   *
   * @param stream - The stream tab ID
   * @param storageKey - THE key for storage operations
   */
  async clearRunMissingOutputs(
    stream: StreamTabId,
    storageKey: StorageKey,
  ): Promise<void> {
    await this.ensureMissingOutputsLoaded();
    const runs = this._missingOutputs.get(stream);
    if (!runs) {
      return;
    }

    const removed = runs.delete(storageKey);
    if (runs.size === 0) {
      this._missingOutputs.delete(stream);
    }

    if (removed) {
      await this.saveMissingOutputs();
    }
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

  /** Get all output files */
  getAllFiles(): Map<StreamTabId, Map<string, Map<number, OutputFileInfo[]>>> {
    return this.getAll();
  }

  /** Get all missing outputs */
  getAllMissingOutputs(): Map<StreamTabId, Map<string, Map<number, string[]>>> {
    if (!this.missingOutputsLoaded) {
      throw new Error('Missing outputs requested before load completed');
    }
    return new Map(this._missingOutputs);
  }

  /** Set all output files (used during loading) */
  setAllFiles(
    files: Map<StreamTabId, Map<string, Map<number, OutputFileInfo[]>>>,
  ): void {
    this.setAll(files);
  }

  /** Set all missing outputs (used during loading) */
  setAllMissingOutputs(
    missing: Map<StreamTabId, Map<string, Map<number, string[]>>>,
  ): void {
    this._missingOutputs = new Map(missing);
    this.missingOutputsLoaded = true;
  }

  /** Load output files from persistence and clean up missing files */
  async load(): Promise<void> {
    await super.load();
    await this.ensureMissingOutputsLoaded();
  }

  /** Load missing outputs from persistence */
  private async loadMissingOutputs(): Promise<void> {
    const saved = this.storage.get<Record<string, unknown>>(
      WorkspaceStateKey.MISSING_OUTPUTS,
      {},
    );

    if (saved && Object.keys(saved).length > 0) {
      this._missingOutputs = this.deserializeMissingOutputs(saved);
      return;
    }

    const migrated = await this.migrateLegacyMissingOutputs();
    if (!migrated) {
      this._missingOutputs.clear();
    }
  }

  private async ensureMissingOutputsLoaded(): Promise<void> {
    if (this.missingOutputsLoaded) {
      return;
    }

    if (!this.missingOutputsLoadPromise) {
      this.missingOutputsLoadPromise = this.loadMissingOutputs()
        .then(() => {
          this.missingOutputsLoaded = true;
        })
        .catch((error) => {
          this.logger.error('Failed to load missing outputs', { data: error });
          this.missingOutputsLoadPromise = null;
          throw error;
        });
    }

    await this.missingOutputsLoadPromise;
  }

  /** Save missing outputs to persistence */
  async saveMissingOutputs(): Promise<void> {
    const obj = Object.fromEntries(
      Array.from(this._missingOutputs.entries(), ([stream, runs]) => [
        stream,
        Object.fromEntries(
          Array.from(runs.entries(), ([runId, rounds]) => [
            runId,
            Object.fromEntries(rounds.entries()),
          ]),
        ),
      ]),
    );
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
    const legacy = this.storage.get<{
      [key: string]: { [key: number]: string[] };
    }>(legacyKey, {});

    if (!legacy || Object.keys(legacy).length === 0) {
      return false;
    }

    const converted: Record<
      string,
      Record<string, { [key: number]: string[] }>
    > = {};

    for (const [stream, rounds] of Object.entries(legacy)) {
      converted[stream] = { [normalizeRunId(null)]: rounds };
    }

    this._missingOutputs = this.deserializeMissingOutputs(converted);
    await this.saveMissingOutputs();
    await this.storage.update(legacyKey, undefined as never);
    return true;
  }

  protected override serialize(
    value: Map<string, Map<number, OutputFileInfo[]>>,
    _key: StreamTabId,
  ): unknown {
    const runs = Object.fromEntries(
      Array.from(value.entries(), ([runId, rounds]) => [
        runId,
        Object.fromEntries(rounds.entries()),
      ]),
    );
    return runs;
  }

  /** Validate and normalize loaded output files */
  protected override async deserialize(
    data: unknown,
    _streamId: StreamTabId,
  ): Promise<Map<string, Map<number, OutputFileInfo[]>>> {
    return OutputFilesDataSchema.parse(data);
  }
}
