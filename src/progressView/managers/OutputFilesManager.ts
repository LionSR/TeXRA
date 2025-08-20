// Local imports - progress view
// Local imports
import { StatePersistenceManager } from '../persistence/StatePersistenceManager';

// Types
import type { DiffStats } from '@agent/types/DiffTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { WorkspaceStateKey } from '@common/state/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';

interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string;
}

/**
 * Manages output files collection with persistence and file existence validation.
 * Handles adding, updating, and managing output files for different streams.
 */
export class OutputFilesManager {
  private _outputFiles: Map<StreamTabId, { [key: number]: OutputFileInfo[] }> =
    new Map();
  private _missingOutputs: Map<StreamTabId, { [key: number]: string[] }> =
    new Map();
  private readonly logger: AgentLogger;

  constructor(private persistence: StatePersistenceManager) {
    this.logger = new AgentLogger('OutputFilesManager');
  }

  /**
   * Add output files for a stream and round
   */
  addFiles(
    stream: StreamTabId,
    filesByRound: { [key: number]: OutputFileInfo[] },
  ): void {
    const existing = this._outputFiles.get(stream) || {};
    const merged = { ...existing, ...filesByRound };
    this._outputFiles.set(stream, merged);
    this.save();
  }

  /**
   * Update missing outputs for a stream
   */
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

  /**
   * Get output files for a stream
   */
  getFiles(
    stream: StreamTabId,
  ): { [key: number]: OutputFileInfo[] } | undefined {
    return this._outputFiles.get(stream);
  }

  /**
   * Get missing outputs for a stream
   */
  getMissingOutputs(
    stream: StreamTabId,
  ): { [key: number]: string[] } | undefined {
    return this._missingOutputs.get(stream);
  }

  /**
   * Clear output files for a stream
   */
  clearFiles(stream: StreamTabId): void {
    this._outputFiles.delete(stream);
    this.save();
  }

  /**
   * Clear missing outputs for a stream
   */
  clearMissingOutputs(stream: StreamTabId): void {
    this._missingOutputs.delete(stream);
    this.saveMissingOutputs();
  }

  /**
   * Delete all files for a stream
   */
  deleteStream(stream: StreamTabId): void {
    this._outputFiles.delete(stream);
    this._missingOutputs.delete(stream);
    this.save();
    this.saveMissingOutputs();
  }

  /**
   * Clear all output files
   */
  clear(): void {
    this._outputFiles.clear();
    this._missingOutputs.clear();
    this.save();
    this.saveMissingOutputs();
  }

  /**
   * Get all output files
   */
  getAllFiles(): Map<StreamTabId, { [key: number]: OutputFileInfo[] }> {
    return new Map(this._outputFiles);
  }

  /**
   * Get all missing outputs
   */
  getAllMissingOutputs(): Map<StreamTabId, { [key: number]: string[] }> {
    return new Map(this._missingOutputs);
  }

  /**
   * Set all output files (used during loading)
   */
  setAllFiles(
    files: Map<StreamTabId, { [key: number]: OutputFileInfo[] }>,
  ): void {
    this._outputFiles = new Map(files);
  }

  /**
   * Set all missing outputs (used during loading)
   */
  setAllMissingOutputs(
    missing: Map<StreamTabId, { [key: number]: string[] }>,
  ): void {
    this._missingOutputs = new Map(missing);
  }

  /**
   * Load output files from persistence and clean up missing files
   */
  async load(): Promise<void> {
    await this.loadOutputFiles();
    await this.loadMissingOutputs();
  }

  /**
   * Load output files and validate they still exist
   */
  private async loadOutputFiles(): Promise<void> {
    const savedFiles = await this.persistence.load<{
      [key: string]: { [key: number]: OutputFileInfo[] };
    }>(WorkspaceStateKey.OUTPUT_FILES, {});

    if (savedFiles && Object.keys(savedFiles).length > 0) {
      const cleaned: [string, { [key: number]: OutputFileInfo[] }][] = [];
      let totalFilesProcessed = 0;
      let totalFilesRemoved = 0;

      for (const [streamId, rounds] of Object.entries(savedFiles)) {
        const roundMap: { [key: number]: OutputFileInfo[] } = {};
        const streamFilesProcessed = Object.values(rounds).reduce(
          (sum, files) => sum + files.length,
          0,
        );
        totalFilesProcessed += streamFilesProcessed;

        for (const [roundStr, infos] of Object.entries(rounds)) {
          const roundNum = parseInt(roundStr, 10);
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
              totalFilesRemoved += removedCount;

              // Log which files were removed for debugging
              const removedFiles = infos.filter(
                (info) => !filtered.find((f) => f.path === info.path),
              );
              removedFiles.forEach((file) => {
                this.logger.debug(`  - Removed missing file: ${file.path}`);
              });
            }

            // Always preserve round structure, even if empty (for UI consistency)
            // Only skip rounds that had no files to begin with
            if (infos.length > 0) {
              roundMap[roundNum] = filtered;
            }
          } catch (error) {
            this.logger.warn(
              `Error checking files in stream ${streamId}, round ${roundNum}: ${error instanceof Error ? error.message : String(error)}`,
            );
            // On error, preserve the original files to avoid data loss
            roundMap[roundNum] = infos;
          }
        }

        // Always preserve streams that had any rounds (even if they become empty)
        if (Object.keys(rounds).length > 0) {
          cleaned.push([streamId, roundMap]);
        }
      }

      this._outputFiles = new Map(cleaned);

      if (totalFilesRemoved > 0) {
        this.logger.info(
          `File cleanup completed: processed ${totalFilesProcessed} files, removed ${totalFilesRemoved} missing files`,
        );
      }
    } else {
      this._outputFiles.clear();
    }
  }

  /**
   * Load missing outputs from persistence
   */
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

  /**
   * Save output files to persistence
   */
  save(): void {
    const filesObj = Object.fromEntries(this._outputFiles.entries());
    this.persistence.save(WorkspaceStateKey.OUTPUT_FILES, filesObj);
  }

  /**
   * Save missing outputs to persistence
   */
  saveMissingOutputs(): void {
    const obj = Object.fromEntries(this._missingOutputs.entries());
    this.persistence.save(WorkspaceStateKey.MISSING_OUTPUTS, obj);
  }
}
