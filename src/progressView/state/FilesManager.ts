// Third-party imports

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { WorkspaceFS } from '@utils/files';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { BaseStateManager } from './BaseStateManager';

// Types
import type { DiffStats } from '../../types/DiffTypes';

interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string;
}

/**
 * Manages generated output files for streams.
 */
export class FilesManager extends BaseStateManager {
  public readonly map: Map<string, { [key: number]: OutputFileInfo[] }> =
    new Map();
  private readonly logger = new AgentLogger('FilesManager');

  async load(): Promise<void> {
    const savedFiles = workspaceSM.get<{
      [key: string]: { [key: number]: OutputFileInfo[] };
    }>(this._getWorkspaceKey(WorkspaceStateKey.OUTPUT_FILES));

    if (savedFiles) {
      const cleaned: [string, { [key: number]: OutputFileInfo[] }][] = [];
      let totalFilesProcessed = 0;
      let totalFilesRemoved = 0;

      for (const [streamId, rounds] of Object.entries(savedFiles)) {
        if (shouldUseConsolidatedChannel(streamId)) {
          continue;
        }

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
              `Error checking files in stream ${streamId}, round ${roundNum}: ${error instanceof Error ? error.message : String(error)}`,
            );
            roundMap[roundNum] = infos;
          }
        }

        if (Object.keys(rounds).length > 0) {
          cleaned.push([streamId, roundMap]);
        }
      }

      this.map.clear();
      for (const [streamId, data] of cleaned) {
        this.map.set(streamId, data);
      }

      if (totalFilesRemoved > 0) {
        this.logger.info(
          `File cleanup completed: processed ${totalFilesProcessed} files, removed ${totalFilesRemoved} missing files`,
        );
      }
    } else {
      this.map.clear();
    }
  }

  save(): void {
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.OUTPUT_FILES),
      Object.fromEntries(this.map.entries()),
    );
  }

  clear(stream: string): void {
    this.map.delete(stream);
  }

  clearAll(): void {
    this.map.clear();
  }
}
