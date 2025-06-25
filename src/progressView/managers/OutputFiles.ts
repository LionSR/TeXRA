// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { WorkspaceFS } from '@utils/files';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';
import { AgentLogger } from '@logger/AgentLogger';
import type { DiffStats } from '../../types/DiffTypes';

interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string;
}

/**
 * Manages output files per stream with persistence.
 */
export class OutputFiles {
  private readonly logger = new AgentLogger('OutputFiles');
  private _files: Map<string, { [key: number]: OutputFileInfo[] }> = new Map();

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  async load(): Promise<void> {
    const saved = workspaceSM.get<{
      [key: string]: { [key: number]: OutputFileInfo[] };
    }>(this._getWorkspaceKey(WorkspaceStateKey.OUTPUT_FILES));

    if (saved) {
      const cleaned: [string, { [key: number]: OutputFileInfo[] }][] = [];
      let totalFilesProcessed = 0;
      let totalFilesRemoved = 0;

      for (const [streamId, rounds] of Object.entries(saved)) {
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
              `Error checking files in stream ${streamId}, round ${roundNum}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            roundMap[roundNum] = infos;
          }
        }

        if (Object.keys(rounds).length > 0) {
          cleaned.push([streamId, roundMap]);
        }
      }

      this._files = new Map(cleaned);

      if (totalFilesRemoved > 0) {
        this.logger.info(
          `File cleanup completed: processed ${totalFilesProcessed} files, removed ${totalFilesRemoved} missing files`,
        );
      }
    } else {
      this._files.clear();
    }
  }

  save(): void {
    const obj = Object.fromEntries(this._files.entries());
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.OUTPUT_FILES),
      obj,
    );
  }

  get(stream: string): { [key: number]: OutputFileInfo[] } | undefined {
    return this._files.get(stream);
  }

  set(stream: string, files: { [key: number]: OutputFileInfo[] }): void {
    this._files.set(stream, files);
  }

  delete(stream: string): void {
    this._files.delete(stream);
  }

  clear(): void {
    this._files.clear();
  }

  entries(): IterableIterator<[string, { [key: number]: OutputFileInfo[] }]> {
    return this._files.entries();
  }

  keys(): IterableIterator<string> {
    return this._files.keys();
  }

  has(stream: string): boolean {
    return this._files.has(stream);
  }
}
