// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import {
  PersistentMapManager,
  type StateStorage,
} from '../persistence/PersistentMapManager';

// Local imports
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';

// Types
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { OutputFileInfo } from '@agent/output/types';

/**
 * Manages output files collection with persistence and file existence validation.
 * Handles adding, updating, and managing output files for different streams.
 */
export class OutputFilesManager extends PersistentMapManager<
  StreamTabId,
  Map<number, OutputFileInfo[]>
> {
  private _missingOutputs: Map<StreamTabId, Map<number, string[]>> = new Map();
  private readonly logger: AgentLogger;
  private totalFilesProcessed = 0;
  private totalFilesRemoved = 0;

  constructor(storage?: StateStorage) {
    super(WorkspaceStateKey.OUTPUT_FILES, storage);
    this.logger = new AgentLogger('OutputFilesManager');
  }

  /** Add output files for a stream and round */
  async addFiles(
    stream: StreamTabId,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): Promise<void> {
    let existing = this.items.get(stream);
    if (!existing) {
      existing = new Map();
      this.items.set(stream, existing);
    }

    for (const [round, files] of Object.entries(filesByRound)) {
      existing.set(Number(round), files);
    }

    await this.save();
  }

  /** Update missing outputs for a stream */
  async updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: { [key: number]: string[] },
  ): Promise<void> {
    let streamMissing = this._missingOutputs.get(stream);
    if (!streamMissing) {
      streamMissing = new Map();
      this._missingOutputs.set(stream, streamMissing);
    }

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = parseInt(round, 10);
      streamMissing.set(roundNum, files);
    }

    await this.saveMissingOutputs();
  }

  /** Get output files for a stream */
  getFiles(stream: StreamTabId): Map<number, OutputFileInfo[]> {
    const files = this.items.get(stream);
    return files ? new Map(files) : new Map();
  }

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): Map<number, string[]> {
    const missing = this._missingOutputs.get(stream);
    return missing ? new Map(missing) : new Map();
  }

  /** Clear output files for a stream */
  async clearFiles(stream: StreamTabId): Promise<void> {
    await this.delete(stream);
  }

  /** Clear missing outputs for a stream */
  async clearMissingOutputs(stream: StreamTabId): Promise<void> {
    if (!this._missingOutputs.delete(stream)) {
      return;
    }
    await this.saveMissingOutputs();
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
  getAllFiles(): Map<StreamTabId, Map<number, OutputFileInfo[]>> {
    return this.getAll();
  }

  /** Get all missing outputs */
  getAllMissingOutputs(): Map<StreamTabId, Map<number, string[]>> {
    return new Map(this._missingOutputs);
  }

  /** Set all output files (used during loading) */
  setAllFiles(files: Map<StreamTabId, Map<number, OutputFileInfo[]>>): void {
    this.setAll(files);
  }

  /** Set all missing outputs (used during loading) */
  setAllMissingOutputs(missing: Map<StreamTabId, Map<number, string[]>>): void {
    this._missingOutputs = new Map(missing);
  }

  /** Load output files from persistence and clean up missing files */
  async load(): Promise<void> {
    this.totalFilesProcessed = 0;
    this.totalFilesRemoved = 0;
    await super.load();
    await this.loadMissingOutputs();
    if (this.totalFilesRemoved > 0) {
      this.logger.info(
        `File cleanup completed: processed ${this.totalFilesProcessed} files, removed ${this.totalFilesRemoved} missing files`,
      );
    }
  }

  /** Load missing outputs from persistence */
  private async loadMissingOutputs(): Promise<void> {
    const saved = this.storage.get<{
      [key: string]: { [key: number]: string[] };
    }>(WorkspaceStateKey.MISSING_OUTPUTS, {});

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
      Array.from(this._missingOutputs.entries(), ([stream, rounds]) => [
        stream,
        Object.fromEntries(rounds.entries()),
      ]),
    );
    await this.storage.update(WorkspaceStateKey.MISSING_OUTPUTS, obj);
  }

  private deserializeMissingOutputs(saved: {
    [key: string]: { [key: number]: string[] };
  }): Map<StreamTabId, Map<number, string[]>> {
    const processed = new Map<StreamTabId, Map<number, string[]>>();

    for (const [stream, rounds] of Object.entries(saved)) {
      const roundEntries = Object.entries(rounds).map(
        ([round, files]) => [parseInt(round, 10), files] as [number, string[]],
      );
      processed.set(stream, new Map(roundEntries));
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

    this._missingOutputs = this.deserializeMissingOutputs(legacy);
    await this.saveMissingOutputs();
    await this.storage.update(legacyKey, undefined as never);
    return true;
  }

  protected override serialize(
    value: Map<number, OutputFileInfo[]>,
    _key: StreamTabId,
  ): unknown {
    return Object.fromEntries(value.entries());
  }

  /** Validate and normalize loaded output files */
  protected override async deserialize(
    data: unknown,
    streamId: StreamTabId,
  ): Promise<Map<number, OutputFileInfo[]>> {
    if (!data || typeof data !== 'object') {
      return new Map();
    }

    const rounds = data as Record<string, unknown>;
    const roundMap = new Map<number, OutputFileInfo[]>();

    for (const [roundKey, value] of Object.entries(rounds)) {
      const round = Number.parseInt(roundKey, 10);
      if (Number.isNaN(round) || !Array.isArray(value)) {
        continue;
      }

      const infos = value as OutputFileInfo[];
      this.totalFilesProcessed += infos.length;

      try {
        const filtered = await WorkspaceFS.filterExistingFiles(infos);
        const removed = infos.length - filtered.length;
        if (removed > 0) {
          this.totalFilesRemoved += removed;
        }
        if (filtered.length > 0) {
          roundMap.set(round, filtered);
        }
      } catch {
        roundMap.set(round, infos);
      }
    }

    return roundMap;
  }
}
