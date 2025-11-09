// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import {
  PersistentMapManager,
  type StateStorage,
} from '../persistence/PersistentMapManager';
import { normalizeRunId } from '../constants/runIds';

// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
import type { TaskRunSessionMetadata } from '@utils/files';

const isValidOutputFile = (value: unknown): value is OutputFileInfo => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<OutputFileInfo>;
  return typeof candidate.path === 'string' && candidate.path.length > 0;
};

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
  private _runMetadata: Map<StreamTabId, Map<string, TaskRunSessionMetadata>> =
    new Map();
  private readonly logger: AgentLogger;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.OUTPUT_FILES, storage);
    this.logger = new AgentLogger('OutputFilesManager');
  }

  /** Add output files for a stream and round */
  async addFiles(
    stream: StreamTabId,
    groupId: string | null | undefined,
    filesByRound: { [key: number]: OutputFileInfo[] },
    session?: TaskRunSessionMetadata,
  ): Promise<void> {
    const runId = normalizeRunId(groupId);

    let streamRuns = this.items.get(stream);
    if (!streamRuns) {
      streamRuns = new Map();
      this.items.set(stream, streamRuns);
    }

    let runRounds = streamRuns.get(runId);
    if (!runRounds) {
      runRounds = new Map();
      streamRuns.set(runId, runRounds);
    }

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = Number.parseInt(round, 10);
      if (Number.isNaN(roundNum)) {
        this.logger.warn(
          `Invalid round number '${round}' for stream ${stream}`,
        );
        continue;
      }
      const normalizedFiles = (Array.isArray(files) ? files : []).filter(
        (file) => isValidOutputFile(file),
      );
      if (normalizedFiles.length === 0) {
        runRounds.delete(roundNum);
        continue;
      }

      runRounds.set(roundNum, normalizedFiles);
    }

    if (session) {
      let streamMetadata = this._runMetadata.get(stream);
      if (!streamMetadata) {
        streamMetadata = new Map();
        this._runMetadata.set(stream, streamMetadata);
      }
      streamMetadata.set(runId, session);
    }

    await this.save();
    if (session) {
      await this.saveRunMetadata();
    }
  }

  /** Update missing outputs for a stream */
  async updateMissingOutputs(
    stream: StreamTabId,
    groupId: string | null | undefined,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
    const runId = normalizeRunId(groupId);

    let streamMissing = this._missingOutputs.get(stream);
    if (!streamMissing) {
      streamMissing = new Map();
      this._missingOutputs.set(stream, streamMissing);
    }

    let runMissing = streamMissing.get(runId);
    if (!runMissing) {
      runMissing = new Map();
      streamMissing.set(runId, runMissing);
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

  /** Get stored metadata for a stream */
  getRunMetadata(stream: StreamTabId): Map<string, TaskRunSessionMetadata> {
    const metadata = this._runMetadata.get(stream);
    return metadata ? new Map(metadata) : new Map();
  }

  /**
   * Return a flattened set of file paths known for the provided stream.
   * Includes both generated artifacts and their original counterparts.
   */
  getKnownFilePaths(stream: StreamTabId): Set<string> {
    const paths = new Set<string>();
    const runs = this.items.get(stream);
    if (!runs) {
      return paths;
    }

    for (const runRounds of runs.values()) {
      for (const infos of runRounds.values()) {
        for (const info of infos) {
          paths.add(info.path);
          if (info.original) {
            paths.add(info.original);
          }
        }
      }
    }

    return paths;
  }

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): Map<string, Map<number, string[]>> {
    const missing = this._missingOutputs.get(stream);
    return missing ? new Map(missing) : new Map();
  }

  /** Clear output files for a stream */
  async clearFiles(stream: StreamTabId): Promise<void> {
    await this.delete(stream);
    if (this._runMetadata.delete(stream)) {
      await this.saveRunMetadata();
    }
  }

  async clearRunFiles(
    stream: StreamTabId,
    groupId: string | null | undefined,
  ): Promise<void> {
    const runId = normalizeRunId(groupId);
    const runs = this.items.get(stream);
    if (!runs) {
      return;
    }

    const removed = runs.delete(runId);
    if (runs.size === 0) {
      this.items.delete(stream);
    }

    const metadata = this._runMetadata.get(stream);
    if (metadata) {
      const metaRemoved = metadata.delete(runId);
      if (metadata.size === 0) {
        this._runMetadata.delete(stream);
      }
      if (metaRemoved) {
        await this.saveRunMetadata();
      }
    }

    if (removed) {
      await this.save();
    }
  }

  /** Clear missing outputs for a stream */
  async clearMissingOutputs(stream: StreamTabId): Promise<void> {
    if (!this._missingOutputs.delete(stream)) {
      return;
    }
    await this.saveMissingOutputs();
  }

  async clearRunMissingOutputs(
    stream: StreamTabId,
    groupId: string | null | undefined,
  ): Promise<void> {
    const runId = normalizeRunId(groupId);
    const runs = this._missingOutputs.get(stream);
    if (!runs) {
      return;
    }

    const removed = runs.delete(runId);
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
    this._missingOutputs.delete(stream);
    if (this._runMetadata.delete(stream)) {
      await this.saveRunMetadata();
    }
    await this.saveMissingOutputs();
  }

  /** Clear all output files */
  async clear(): Promise<void> {
    await super.clear();
    this._missingOutputs.clear();
    this._runMetadata.clear();
    await this.saveMissingOutputs();
    await this.saveRunMetadata();
  }

  /** Get all output files */
  getAllFiles(): Map<StreamTabId, Map<string, Map<number, OutputFileInfo[]>>> {
    return this.getAll();
  }

  /** Get all stored run metadata */
  getAllRunMetadata(): Map<StreamTabId, Map<string, TaskRunSessionMetadata>> {
    return new Map(this._runMetadata);
  }

  /** Get all missing outputs */
  getAllMissingOutputs(): Map<StreamTabId, Map<string, Map<number, string[]>>> {
    return new Map(this._missingOutputs);
  }

  /** Set all output files (used during loading) */
  setAllFiles(
    files: Map<StreamTabId, Map<string, Map<number, OutputFileInfo[]>>>,
  ): void {
    this.setAll(files);
  }

  setAllRunMetadata(
    metadata: Map<StreamTabId, Map<string, TaskRunSessionMetadata>>,
  ): void {
    this._runMetadata = new Map(metadata);
  }

  /** Set all missing outputs (used during loading) */
  setAllMissingOutputs(
    missing: Map<StreamTabId, Map<string, Map<number, string[]>>>,
  ): void {
    this._missingOutputs = new Map(missing);
  }

  /** Load output files from persistence and clean up missing files */
  async load(): Promise<void> {
    await super.load();
    await this.loadMissingOutputs();
    await this.loadRunMetadata();
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

  private async loadRunMetadata(): Promise<void> {
    const saved = this.storage.get<Record<string, unknown>>(
      WorkspaceStateKey.OUTPUT_RUN_METADATA,
      {},
    );

    if (saved && Object.keys(saved).length > 0) {
      this._runMetadata = this.deserializeRunMetadata(saved);
      return;
    }

    this._runMetadata.clear();
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

  async saveRunMetadata(): Promise<void> {
    const obj = Object.fromEntries(
      Array.from(this._runMetadata.entries(), ([stream, runs]) => [
        stream,
        Object.fromEntries(runs.entries()),
      ]),
    );
    await this.storage.update(WorkspaceStateKey.OUTPUT_RUN_METADATA, obj);
  }

  private deserializeRunMetadata(
    saved: Record<string, unknown>,
  ): Map<StreamTabId, Map<string, TaskRunSessionMetadata>> {
    const processed = new Map<
      StreamTabId,
      Map<string, TaskRunSessionMetadata>
    >();

    for (const [stream, raw] of Object.entries(saved)) {
      if (!raw || typeof raw !== 'object') {
        processed.set(stream as StreamTabId, new Map());
        continue;
      }

      const entries = Object.entries(raw as Record<string, unknown>);
      const runMap = new Map<string, TaskRunSessionMetadata>();

      for (const [runId, value] of entries) {
        if (!value || typeof value !== 'object') {
          continue;
        }

        const session = this.normalizeSessionMetadata(
          value as Record<string, unknown>,
        );
        if (session) {
          runMap.set(runId, session);
        }
      }

      processed.set(stream as StreamTabId, runMap);
    }

    return processed;
  }

  private normalizeSessionMetadata(
    candidate: Record<string, unknown>,
  ): TaskRunSessionMetadata | null {
    const mode = candidate.storageMode;
    if (mode !== 'workspace' && mode !== 'taskRunStorage') {
      return null;
    }

    const runDirectory =
      typeof candidate.runDirectory === 'string'
        ? candidate.runDirectory
        : undefined;
    const runRelativeRoot =
      typeof candidate.runRelativeRoot === 'string'
        ? candidate.runRelativeRoot
        : undefined;

    return {
      storageMode: mode,
      runDirectory,
      runRelativeRoot,
    };
  }

  private deserializeMissingOutputs(
    saved: Record<string, unknown>,
  ): Map<StreamTabId, Map<string, Map<number, string[]>>> {
    const processed = new Map<
      StreamTabId,
      Map<string, Map<number, string[]>>
    >();

    for (const [stream, raw] of Object.entries(saved)) {
      if (!raw || typeof raw !== 'object') {
        processed.set(stream, new Map());
        continue;
      }

      const entries = Object.entries(raw as Record<string, unknown>);
      const looksLegacy = entries.every(
        ([key]) => !Number.isNaN(Number.parseInt(key, 10)),
      );

      const runMap = new Map<string, Map<number, string[]>>();

      if (looksLegacy) {
        const rounds = this.deserializeRoundMap<string>(
          raw as Record<string, unknown>,
        );
        if (rounds.size > 0) {
          runMap.set(normalizeRunId(null), rounds);
        }
      } else {
        for (const [runId, value] of entries) {
          if (!value || typeof value !== 'object') {
            continue;
          }
          const rounds = this.deserializeRoundMap<string>(
            value as Record<string, unknown>,
          );
          if (rounds.size > 0) {
            runMap.set(runId, rounds);
          }
        }
      }

      processed.set(stream, runMap);
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

  private deserializeRoundMap<T>(
    record: Record<string, unknown>,
    validator?: (value: unknown) => value is T,
  ): Map<number, T[]> {
    const roundMap = new Map<number, T[]>();

    for (const [roundKey, value] of Object.entries(record)) {
      const round = Number.parseInt(roundKey, 10);
      if (Number.isNaN(round)) {
        this.logger.warn(`Invalid round number '${roundKey}' during load`);
        continue;
      }
      if (!Array.isArray(value)) {
        continue;
      }

      if (!validator) {
        roundMap.set(round, value as T[]);
        continue;
      }

      const filtered = (value as unknown[]).filter((entry) => validator(entry));
      if (filtered.length > 0) {
        roundMap.set(round, filtered as T[]);
      }
    }

    return roundMap;
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
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const record = data as Record<string, unknown>;
    const entries = Object.entries(record);
    const looksLegacy = entries.every(
      ([key]) => !Number.isNaN(Number.parseInt(key, 10)),
    );

    const runMap = new Map<string, Map<number, OutputFileInfo[]>>();

    if (looksLegacy) {
      const rounds = this.deserializeRoundMap<OutputFileInfo>(
        record,
        isValidOutputFile,
      );
      if (rounds.size > 0) {
        runMap.set(normalizeRunId(null), rounds);
      }
      return runMap;
    }

    for (const [runId, value] of entries) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const rounds = this.deserializeRoundMap<OutputFileInfo>(
        value as Record<string, unknown>,
        isValidOutputFile,
      );
      if (rounds.size > 0) {
        runMap.set(runId, rounds);
      }
    }

    return runMap;
  }
}
