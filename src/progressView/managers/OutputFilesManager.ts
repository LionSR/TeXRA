// Standard library imports
import * as path from 'path';

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
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import {
  OutputFileInfoListSchema,
  type OutputFileInfo,
} from '@agent/output/types';

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

  private readonly parseStringValue = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;

  /** Add output files for a stream and round */
  async addFiles(
    stream: StreamTabId,
    groupId: string | null | undefined,
    filesByRound: { [key: number]: OutputFileInfo[] },
    options: { executionId?: ExecutionId } = {},
  ): Promise<void> {
    const runId = normalizeRunId(options.executionId ?? groupId);

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

  /** Update missing outputs for a stream */
  async updateMissingOutputs(
    stream: StreamTabId,
    groupId: string | null | undefined,
    filesByRound: { [key: number]: string[] },
    options: { executionId?: ExecutionId } = {},
  ): Promise<void> {
    await this.ensureMissingOutputsLoaded();
    const runId = normalizeRunId(options.executionId ?? groupId);

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

  getRun(
    stream: StreamTabId,
    runId: string,
  ): Map<number, OutputFileInfo[]> | undefined {
    const runs = this.items.get(stream);
    if (!runs) {
      return undefined;
    }

    const target = runs.get(runId);
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

  getRunByExecution(
    stream: StreamTabId,
    executionId: ExecutionId,
  ): Map<number, OutputFileInfo[]> | undefined {
    const normalized = normalizeRunId(executionId);
    const direct = this.getRun(stream, normalized);
    if (direct) {
      return direct;
    }

    const runs = this.items.get(stream);
    if (!runs) {
      return undefined;
    }

    for (const [runKey, rounds] of runs.entries()) {
      for (const infos of rounds.values()) {
        if (
          infos.some(
            (info) =>
              info.rawLocation?.runStorage?.storageRelativePath?.includes(
                executionId,
              ) || info.rawOutputPath?.includes(executionId),
          )
        ) {
          return this.getRun(stream, runKey);
        }
      }
    }

    return undefined;
  }

  /**
   * Return a flattened set of file paths known for the provided stream.
   * When workspaceOnly is true, only workspace-scoped paths are returned so
   * commands like pack/clean do not accidentally target run-storage artifacts.
   */
  getKnownFilePaths(
    stream: StreamTabId,
    options: { runId?: string | null; workspaceOnly?: boolean } = {},
  ): Set<string> {
    const paths = new Set<string>();
    const runs = this.items.get(stream);
    if (!runs) {
      return paths;
    }

    const targetRunIds =
      options.runId !== undefined
        ? [normalizeRunId(options.runId)]
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

  private collectAllPaths(target: Set<string>, info: OutputFileInfo): void {
    this.addPath(target, info.path);
    this.addPath(target, info.original);
  }

  private collectWorkspacePaths(
    target: Set<string>,
    info: OutputFileInfo,
  ): void {
    this.addPath(target, info.workspacePath ?? undefined);
    this.addWorkspaceAbsolute(target, info.location.workspace?.absolutePath);
    this.addPath(target, info.original ?? undefined);
    this.addWorkspaceAbsolute(
      target,
      info.originalLocation?.workspace?.absolutePath,
    );
    this.addWorkspaceAbsolute(
      target,
      info.baseLocation?.workspace?.absolutePath,
    );
    this.addWorkspaceAbsolute(
      target,
      info.prevLocation?.workspace?.absolutePath,
    );
    this.addWorkspaceAbsolute(
      target,
      info.rawLocation?.workspace?.absolutePath,
    );

    if (info.location.scope === 'workspace') {
      this.addWorkspaceAbsolute(target, info.location.absolutePath);
    }

    if (info.rawLocation?.scope === 'workspace') {
      this.addWorkspaceAbsolute(target, info.rawLocation.absolutePath);
    }

    if (this.isWorkspacePath(info.rawOutputPath)) {
      this.addWorkspaceAbsolute(target, info.rawOutputPath);
    }
  }

  private normalizePathForComparison(candidate: string): string {
    return process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  }

  private isWorkspacePath(
    candidate: string | null | undefined,
  ): candidate is string {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return false;
    }

    if (!path.isAbsolute(candidate)) {
      return false;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return false;
    }

    const normalizedCandidate = this.normalizePathForComparison(
      path.resolve(candidate),
    );

    return folders.some((folder) => {
      const rootResolved = path.resolve(folder.uri.fsPath);
      const normalizedRoot = this.normalizePathForComparison(rootResolved);
      if (normalizedCandidate === normalizedRoot) {
        return true;
      }
      const rootWithSep = normalizedRoot.endsWith(path.sep)
        ? normalizedRoot
        : `${normalizedRoot}${path.sep}`;
      return normalizedCandidate.startsWith(rootWithSep);
    });
  }

  private containsRunStorageSegment(candidate: string): boolean {
    return candidate.split(/[\\/]/).includes('taskRuns');
  }

  private addWorkspaceAbsolute(
    target: Set<string>,
    candidate: string | null | undefined,
  ): void {
    if (typeof candidate !== 'string') {
      return;
    }

    if (!this.isWorkspacePath(candidate)) {
      return;
    }

    if (this.containsRunStorageSegment(candidate)) {
      return;
    }

    this.addPath(target, candidate);
  }

  private addPath(target: Set<string>, candidate: string | null | undefined) {
    if (typeof candidate !== 'string') {
      return;
    }

    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      return;
    }

    target.add(trimmed);
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

  async clearRunMissingOutputs(
    stream: StreamTabId,
    groupId: string | null | undefined,
  ): Promise<void> {
    await this.ensureMissingOutputsLoaded();
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
          this.logger.error('Failed to load missing outputs', error);
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
          this.parseStringValue,
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
            this.parseStringValue,
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
    parser?: (value: unknown) => T | null,
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

      if (!parser) {
        roundMap.set(round, value as T[]);
        continue;
      }

      const parsed = (value as unknown[])
        .map((entry) => parser(entry))
        .filter((entry): entry is T => entry !== null);
      if (parsed.length > 0) {
        roundMap.set(round, parsed);
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
      const rounds = this.deserializeRoundMap<OutputFileInfo>(record);
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
      );
      if (rounds.size > 0) {
        runMap.set(runId, rounds);
      }
    }

    return runMap;
  }
}
