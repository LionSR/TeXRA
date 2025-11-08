// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import {
  PersistentMapManager,
  type StateStorage,
} from '../persistence/PersistentMapManager';

// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';

// Types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';
import { DEFAULT_RUN_ID } from '../constants';
import { AgentLogger } from '@logger/AgentLogger';

/**
 * Manages output files collection with persistence and file existence validation.
 * Handles adding, updating, and managing output files for different streams.
 */
export class OutputFilesManager extends PersistentMapManager<
  StreamTabId,
  Map<string, Map<number, OutputFileInfo[]>>
> {
  private readonly logger = new AgentLogger('OutputFilesManager');
  private _missingOutputs: Map<
    StreamTabId,
    Map<string, Map<number, string[]>>
  > = new Map();

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.OUTPUT_FILES, storage);
  }

  /** Add output files for a stream and round */
  async addFiles(
    stream: StreamTabId,
    groupId: string | undefined,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): Promise<void> {
    const runId = groupId ?? DEFAULT_RUN_ID;

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
          `Invalid round number "${round}" for stream ${stream} (run ${runId})`,
        );
        continue;
      }
      runRounds.set(roundNum, files);
    }

    await this.save();
  }

  /** Update missing outputs for a stream */
  async updateMissingOutputs(
    stream: StreamTabId,
    groupId: string | undefined,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
    const runId = groupId ?? DEFAULT_RUN_ID;

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
          `Invalid round number "${round}" for missing outputs on stream ${stream} (run ${runId})`,
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

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): Map<string, Map<number, string[]>> {
    const missing = this._missingOutputs.get(stream);
    return missing ? new Map(missing) : new Map();
  }

  /** Clear output files for a stream */
  async clearFiles(stream: StreamTabId): Promise<void> {
    await this.delete(stream);
  }

  async clearRunFiles(
    stream: StreamTabId,
    groupId: string | undefined,
  ): Promise<void> {
    const runId = groupId ?? DEFAULT_RUN_ID;
    const runs = this.items.get(stream);
    if (!runs) {
      return;
    }

    const removed = runs.delete(runId);
    if (runs.size === 0) {
      this.items.delete(stream);
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
    groupId: string | undefined,
  ): Promise<void> {
    const runId = groupId ?? DEFAULT_RUN_ID;
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
    await this.saveMissingOutputs();
  }

  /** Clear all output files */
  async clear(): Promise<void> {
    await super.clear();
    this._missingOutputs.clear();
    await this.saveMissingOutputs();
  }

  /** Get all output files */
  getAllFiles(): Map<StreamTabId, Map<string, Map<number, OutputFileInfo[]>>> {
    return this.getAll();
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
          { stream },
        );
        if (rounds.size > 0) {
          runMap.set(DEFAULT_RUN_ID, rounds);
        }
      } else {
        for (const [runId, value] of entries) {
          if (!value || typeof value !== 'object') {
            continue;
          }
          const rounds = this.deserializeRoundMap<string>(
            value as Record<string, unknown>,
            { stream, runId },
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
      converted[stream] = { [DEFAULT_RUN_ID]: rounds };
    }

    this._missingOutputs = this.deserializeMissingOutputs(converted);
    await this.saveMissingOutputs();
    await this.storage.update(legacyKey, undefined as never);
    return true;
  }

  private deserializeRoundMap<T>(
    record: Record<string, unknown>,
    context?: { stream?: StreamTabId; runId?: string },
  ): Map<number, T[]> {
    const roundMap = new Map<number, T[]>();

    for (const [roundKey, value] of Object.entries(record)) {
      const round = Number.parseInt(roundKey, 10);
      if (Number.isNaN(round) || !Array.isArray(value)) {
        this.logger.warn(
          `Skipping invalid round "${roundKey}" while loading output metadata${
            context?.stream ? ` for stream ${context.stream}` : ''
          }${context?.runId ? ` (run ${context.runId})` : ''}`,
        );
        continue;
      }

      roundMap.set(round, value as T[]);
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
      const rounds = this.deserializeRoundMap<OutputFileInfo>(record, {
        stream: _streamId,
      });
      if (rounds.size > 0) {
        runMap.set(DEFAULT_RUN_ID, rounds);
      }
      return runMap;
    }

    for (const [runId, value] of entries) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      const rounds = this.deserializeRoundMap<OutputFileInfo>(
        value as Record<string, unknown>,
        { stream: _streamId, runId },
      );
      if (rounds.size > 0) {
        runMap.set(runId, rounds);
      }
    }

    return runMap;
  }
}
