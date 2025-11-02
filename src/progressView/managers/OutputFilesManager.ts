// Local imports - progress view
import { PersistentMapManager } from '../persistence/PersistentMapManager';
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

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
  { [key: number]: OutputFileInfo[] }
> {
  private _missingOutputs: Map<StreamTabId, { [key: number]: string[] }> =
    new Map();
  private readonly logger: AgentLogger;
  private totalFilesProcessed = 0;
  private totalFilesRemoved = 0;

  constructor(persistence: StatePersistenceManager) {
    super(persistence, WorkspaceStateKey.OUTPUT_FILES);
    this.logger = new AgentLogger('OutputFilesManager');
  }

  /** Add output files for a stream and round */
  addFiles(
    stream: StreamTabId,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): void {
    const existing = this.ensureStreamFiles(stream);

    for (const [round, files] of Object.entries(filesByRound)) {
      existing[Number(round)] = files;
    }

    this.save();
  }

  /** Update missing outputs for a stream */
  updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: { [key: number]: string[] },
  ): void {
    const streamMissing = this.ensureMissingOutputs(stream);

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = parseInt(round, 10);
      streamMissing[roundNum] = files;
    }

    this.saveMissingOutputs();
  }

  /** Get output files for a stream */
  getFiles(stream: StreamTabId): { [key: number]: OutputFileInfo[] } {
    const files = this.items.get(stream);
    if (files) {
      return files;
    }
    return {};
  }

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): { [key: number]: string[] } {
    const missing = this._missingOutputs.get(stream);
    if (missing) {
      return missing;
    }
    return {};
  }

  /** Clear output files for a stream */
  clearFiles(stream: StreamTabId): void {
    this.delete(stream);
  }

  /** Clear missing outputs for a stream */
  clearMissingOutputs(stream: StreamTabId): void {
    if (!this._missingOutputs.delete(stream)) {
      return;
    }
    this.saveMissingOutputs();
  }

  /** Delete all files for a stream */
  deleteStream(stream: StreamTabId): void {
    super.delete(stream);
    this._missingOutputs.delete(stream);
    this.saveMissingOutputs();
  }

  /** Clear all output files */
  clear(): void {
    super.clear();
    this._missingOutputs.clear();
    this.saveMissingOutputs();
  }

  /** Get all output files */
  getAllFiles(): Map<StreamTabId, { [key: number]: OutputFileInfo[] }> {
    return this.getAll();
  }

  /** Get all missing outputs */
  getAllMissingOutputs(): Map<StreamTabId, { [key: number]: string[] }> {
    return new Map(this._missingOutputs);
  }

  /** Set all output files (used during loading) */
  setAllFiles(
    files: Map<StreamTabId, { [key: number]: OutputFileInfo[] }>,
  ): void {
    this.setAll(files);
  }

  /** Set all missing outputs (used during loading) */
  setAllMissingOutputs(
    missing: Map<StreamTabId, { [key: number]: string[] }>,
  ): void {
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
    const saved = await this.persistence.load<{
      [key: string]: { [key: number]: string[] };
    }>(WorkspaceStateKey.MISSING_OUTPUTS, {});

    if (saved && Object.keys(saved).length > 0) {
      const processed = new Map<StreamTabId, { [key: number]: string[] }>();

      for (const [stream, rounds] of Object.entries(saved)) {
        const roundMap = Object.fromEntries(
          Object.entries(rounds).map(([r, files]) => [parseInt(r, 10), files]),
        );
        processed.set(stream, roundMap);
      }

      this._missingOutputs = processed;
    } else {
      this._missingOutputs.clear();
    }
  }

  /** Save missing outputs to persistence */
  saveMissingOutputs(): void {
    const obj = Object.fromEntries(this._missingOutputs.entries());
    this.persistence.save(WorkspaceStateKey.MISSING_OUTPUTS, obj);
  }

  private ensureStreamFiles(stream: StreamTabId): {
    [key: number]: OutputFileInfo[];
  } {
    let files = this.items.get(stream);
    if (!files) {
      files = {};
      this.items.set(stream, files);
    }
    return files;
  }

  private ensureMissingOutputs(stream: StreamTabId): {
    [key: number]: string[];
  } {
    let missing = this._missingOutputs.get(stream);
    if (!missing) {
      missing = {};
      this._missingOutputs.set(stream, missing);
    }
    return missing;
  }

  /** Validate and normalize loaded output files */
  protected override async deserialize(
    data: unknown,
    streamId: StreamTabId,
  ): Promise<{ [key: number]: OutputFileInfo[] }> {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const rounds = data as Record<string, unknown>;
    const roundMap: { [key: number]: OutputFileInfo[] } = {};

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
          roundMap[round] = filtered;
        }
      } catch {
        roundMap[round] = infos;
      }
    }

    return roundMap;
  }
}
