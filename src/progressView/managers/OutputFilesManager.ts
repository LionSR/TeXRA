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
    filesByRound: Record<number, OutputFileInfo[]>,
  ): void {
    const existing = this.getFiles(stream);
    const merged = { ...existing, ...filesByRound };
    this.add(stream, merged);
  }

  /** Update missing outputs for a stream */
  updateMissingOutputs(
    stream: StreamTabId,
    filesByRound: { [key: number]: string[] },
  ): void {
    if (!this._missingOutputs.has(stream)) {
      this._missingOutputs.set(stream, {});
    }

    const streamMissing = this._missingOutputs.get(stream)!;

    for (const [round, files] of Object.entries(filesByRound)) {
      const roundNum = parseInt(round, 10);
      streamMissing[roundNum] = files;
    }

    this.saveMissingOutputs();
  }

  /** Get output files for a stream */
  getFiles(stream: StreamTabId): Record<number, OutputFileInfo[]> {
    return this.get(stream) ?? {};
  }

  /** Get missing outputs for a stream */
  getMissingOutputs(stream: StreamTabId): Record<number, string[]> {
    return this._missingOutputs.get(stream) ?? {};
  }

  /** Clear output files for a stream */
  clearFiles(stream: StreamTabId): void {
    this.delete(stream);
  }

  /** Clear missing outputs for a stream */
  clearMissingOutputs(stream: StreamTabId): void {
    this._missingOutputs.delete(stream);
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

  /** Validate and normalize loaded output files */
  protected override async deserialize(
    data: unknown,
    streamId: StreamTabId,
  ): Promise<{ [key: number]: OutputFileInfo[] }> {
    if (!data || typeof data !== 'object') {
      this.logger.warn(
        `Invalid output files payload for stream ${streamId}; resetting entry`,
      );
      return {};
    }

    const rounds = data as Record<string, unknown>;
    const roundMap: { [key: number]: OutputFileInfo[] } = {};
    const streamFilesProcessed = Object.values(rounds).reduce<number>(
      (sum, value) => {
        if (Array.isArray(value)) {
          return sum + value.length;
        }
        return sum;
      },
      0,
    );
    this.totalFilesProcessed += streamFilesProcessed;

    for (const [roundStr, value] of Object.entries(rounds)) {
      const roundNum = parseInt(roundStr, 10);
      if (Number.isNaN(roundNum)) {
        this.logger.warn(
          `Skipping non-numeric round key "${roundStr}" for stream ${streamId}`,
        );
        continue;
      }

      if (!Array.isArray(value)) {
        this.logger.warn(
          `Skipping invalid output metadata for stream ${streamId}, round ${roundNum}`,
        );
        continue;
      }

      const infos = value as OutputFileInfo[];
      this.logger.debug(
        `Checking ${infos.length} files in stream ${streamId}, round ${roundNum}`,
      );

      try {
        const filtered = await WorkspaceFS.filterExistingFiles(infos);
        const removedCount = infos.length - filtered.length;

        if (removedCount > 0) {
          this.logger.debug(
            `Removed ${removedCount} missing file(s) from stream ${streamId}, round ${roundNum}`,
          );
          this.totalFilesRemoved += removedCount;
          const removedFiles = infos.filter(
            (info) => !filtered.find((f) => f.path === info.path),
          );
          removedFiles.forEach((file) => {
            this.logger.debug(`  - Removed missing file: ${file.path}`);
          });
        }

        if (infos.length > 0) {
          roundMap[roundNum] = filtered;
        }
      } catch (error) {
        this.logger.warn(
          `Error checking files in stream ${streamId}, round ${roundNum}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        roundMap[roundNum] = infos;
      }
    }

    return roundMap;
  }
}
