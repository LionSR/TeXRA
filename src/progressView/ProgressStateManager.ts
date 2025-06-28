// Third-party imports
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { WorkspaceFS } from '@utils/files';
import { objectToTaskState } from '@utils/config';
import { TaskState } from '@logger/TaskState';
import { AgentLogger } from '@logger/AgentLogger';

// Types
import { TokenUsageStats } from '../types/UsageTypes';
import { TaskGroup, LogMessageData } from '../logger/LogTypes';
import type { DiffStats } from '../types/DiffTypes';

interface OutputFileInfo extends DiffStats {
  path: string;
  base?: string | null;
  prev?: string | null;
  original?: string;
}

/**
 * Manages persistence of progress view state to workspace storage.
 * Handles loading and saving of log streams, groups, output files,
 * task states, and usage statistics.
 */
export class ProgressStateManager {
  private readonly logger: AgentLogger;

  // State collections
  private _logStreams: Map<string, LogMessageData[]> = new Map();
  private _taskGroups: Map<string, Map<string, TaskGroup>> = new Map();
  private _outputFiles: Map<string, { [key: number]: OutputFileInfo[] }> =
    new Map();
  private _missingOutputs: Map<string, Map<number, string>> = new Map();
  private _taskStates: Map<string, TaskState> = new Map();
  private _usageStats: Map<string, TokenUsageStats> = new Map();
  private _activeStream: string = '';

  constructor() {
    this.logger = new AgentLogger('ProgressStateManager');
  }

  // Getters for state collections
  get logStreams(): Map<string, LogMessageData[]> {
    return this._logStreams;
  }

  get taskGroups(): Map<string, Map<string, TaskGroup>> {
    return this._taskGroups;
  }

  get outputFiles(): Map<string, { [key: number]: OutputFileInfo[] }> {
    return this._outputFiles;
  }

  get missingOutputs(): Map<string, Map<number, string>> {
    return this._missingOutputs;
  }

  get taskStates(): Map<string, TaskState> {
    return this._taskStates;
  }

  get usageStats(): Map<string, TokenUsageStats> {
    return this._usageStats;
  }

  get activeStream(): string {
    return this._activeStream;
  }

  set activeStream(stream: string) {
    this._activeStream = stream;
  }

  /**
   * Get workspace-specific storage key
   */
  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  /**
   * Load all state from workspace storage
   */
  public async loadState(): Promise<void> {
    await this._loadLogStreams();
    await this._loadTaskGroups();
    await this._loadOutputFiles();
    await this._loadMissingOutputs();
    this._loadActiveStream();
    await this._loadTaskStates();
    await this._loadUsageStats();
  }

  /**
   * Save all state to workspace storage
   */
  public saveState(): void {
    this._saveLogStreams();
    this._saveTaskGroups();
    this._saveOutputFiles();
    this._saveMissingOutputs();
    this._saveActiveStream();
    this._saveTaskStates();
    this._saveUsageStats();
  }

  /**
   * Load log streams from storage
   */
  private async _loadLogStreams(): Promise<void> {
    const savedState = workspaceSM.get<{
      [key: string]: LogMessageData[] | any[];
    }>(this._getWorkspaceKey(WorkspaceStateKey.LOG_STREAMS));

    if (savedState) {
      // Only load persisted channels
      this._logStreams = new Map(
        Object.entries(savedState).map(([stream, messages]) => [
          stream,
          messages.map((msg: any) => {
            if (!msg.id) {
              msg.id = randomUUID();
            }
            if (msg.text === undefined && msg.message !== undefined) {
              msg.text = msg.message;
            }
            if (msg.timestamp === undefined) {
              const attrMatch =
                typeof msg.text === 'string'
                  ? msg.text.match(/data-full-timestamp="([^"]+)"/)
                  : null;
              const timeString =
                attrMatch?.[1] ||
                (typeof msg.text === 'string'
                  ? (msg.text.match(/\[(.*?)\]/)?.[1] ?? '')
                  : '');
              const timestamp = new Date(timeString).getTime();
              msg.timestamp = isNaN(timestamp) ? Date.now() : timestamp;
            }
            if (!msg.messageType) {
              msg.messageType = 'default';
            }
            return msg as LogMessageData;
          }),
        ]),
      );
    } else {
      this._logStreams.clear();
    }
  }

  /**
   * Load log groups from storage
   */
  private async _loadTaskGroups(): Promise<void> {
    let savedGroups = workspaceSM.get<{
      [key: string]: { [groupId: string]: TaskGroup };
    }>(this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS));

    // Migrate data stored under the old key if needed
    if (!savedGroups) {
      const oldGroups = workspaceSM.get<{
        [key: string]: { [groupId: string]: TaskGroup };
      }>(this._getWorkspaceKey('texra.logGroups'));
      if (oldGroups) {
        savedGroups = oldGroups;
        await workspaceSM.update(
          this._getWorkspaceKey('texra.logGroups'),
          undefined,
        );
        this.logger.debug('Migrated log groups to task groups');
      }
    }

    if (savedGroups) {
      this._taskGroups = new Map(
        Object.entries(savedGroups).map(([streamId, groups]) => [
          streamId,
          new Map(
            Object.entries(groups).map(([id, g]) => [
              id,
              {
                ...g,
                startTime:
                  typeof g.startTime === 'string'
                    ? new Date(g.startTime).getTime()
                    : g.startTime,
                endTime:
                  g.endTime !== undefined
                    ? typeof g.endTime === 'string'
                      ? new Date(g.endTime).getTime()
                      : g.endTime
                    : undefined,
              },
            ]),
          ),
        ]),
      );
    } else {
      this._taskGroups.clear();
    }
  }

  /**
   * Load output files and clean up any that no longer exist
   */
  private async _loadOutputFiles(): Promise<void> {
    const savedFiles = workspaceSM.get<{
      [key: string]: { [key: number]: OutputFileInfo[] };
    }>(this._getWorkspaceKey(WorkspaceStateKey.OUTPUT_FILES));

    if (savedFiles) {
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
   * Load missing outputs from storage
   */
  private async _loadMissingOutputs(): Promise<void> {
    const savedMissing = workspaceSM.get<{
      [key: string]: { [key: number]: string };
    }>(this._getWorkspaceKey(WorkspaceStateKey.MISSING_OUTPUTS));

    if (savedMissing) {
      this._missingOutputs = new Map(
        Object.entries(savedMissing).map(([streamId, rounds]) => [
          streamId,
          new Map(
            Object.entries(rounds).map(([roundStr, xml]) => [
              parseInt(roundStr, 10),
              xml,
            ]),
          ),
        ]),
      );
    } else {
      this._missingOutputs.clear();
    }
  }

  /**
   * Load active stream
   */
  private _loadActiveStream(): void {
    const savedActiveStream = workspaceSM.get<string>(
      WorkspaceStateKey.ACTIVE_LOG_STREAM,
    );
    if (savedActiveStream && this._logStreams.has(savedActiveStream)) {
      this._activeStream = savedActiveStream;
    } else {
      this._activeStream = Array.from(this._logStreams.keys())[0] ?? '';
    }
  }

  /**
   * Load task states
   */
  private async _loadTaskStates(): Promise<void> {
    const savedTaskStates = workspaceSM.get<
      { [key: string]: Record<string, any> } | [string, Record<string, any>][]
    >(WorkspaceStateKey.TASK_STATES);

    if (savedTaskStates) {
      if (Array.isArray(savedTaskStates)) {
        // Backwards compatibility: convert from array format if encountered
        this._taskStates = new Map(
          savedTaskStates.map(([stream, state]) => [
            stream,
            objectToTaskState(state),
          ]),
        );
      } else {
        this._taskStates = new Map(
          Object.entries(savedTaskStates).map(([stream, state]) => [
            stream,
            objectToTaskState(state),
          ]),
        );
      }
    } else {
      this._taskStates.clear();
    }
  }

  /**
   * Load usage statistics
   */
  private async _loadUsageStats(): Promise<void> {
    const savedUsage = workspaceSM.get<{
      [key: string]: {
        inputTokens: number;
        outputTokens: number;
        cost: number;
      };
    }>(WorkspaceStateKey.USAGE_STATS);

    if (savedUsage) {
      this._usageStats = new Map(Object.entries(savedUsage));
    } else {
      this._usageStats.clear();
    }
  }

  /**
   * Save log streams to storage
   */
  private _saveLogStreams(): void {
    const persistentStreams = Array.from(this._logStreams.entries());
    const stateObj = Object.fromEntries(persistentStreams);
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.LOG_STREAMS),
      stateObj,
    );
  }

  /**
   * Save log groups to storage
   */
  private _saveTaskGroups(): void {
    const persistentGroups = Array.from(this._taskGroups.entries()).map(
      ([streamId, groups]) => [streamId, Object.fromEntries(groups.entries())],
    );
    const groupsObj = Object.fromEntries(persistentGroups);
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.TASK_GROUPS),
      groupsObj,
    );
  }

  /**
   * Save output files to storage
   */
  private _saveOutputFiles(): void {
    const filesObj = Object.fromEntries(this._outputFiles.entries());
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.OUTPUT_FILES),
      filesObj,
    );
  }

  /**
   * Save missing outputs to storage
   */
  private _saveMissingOutputs(): void {
    const missingObj: Record<string, Record<number, string>> = {};
    for (const [stream, rounds] of this._missingOutputs.entries()) {
      missingObj[stream] = Object.fromEntries(rounds.entries());
    }
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.MISSING_OUTPUTS),
      missingObj,
    );
  }

  /**
   * Save active stream
   */
  private _saveActiveStream(): void {
    workspaceSM.update(WorkspaceStateKey.ACTIVE_LOG_STREAM, this._activeStream);
  }

  /**
   * Save task states
   */
  private _saveTaskStates(): void {
    const taskStatesObj = Object.fromEntries(this._taskStates.entries());
    workspaceSM.update(WorkspaceStateKey.TASK_STATES, taskStatesObj);
  }

  /**
   * Save usage statistics
   */
  private _saveUsageStats(): void {
    const usageObj = Object.fromEntries(this._usageStats.entries());
    workspaceSM.update(WorkspaceStateKey.USAGE_STATS, usageObj);
  }

  /**
   * Clear all state for a specific stream
   */
  public clearStream(stream: string): void {
    this._logStreams.delete(stream);
    this._taskGroups.delete(stream);
    this._outputFiles.delete(stream);
    this._missingOutputs.delete(stream);
    this._taskStates.delete(stream);
    this._usageStats.delete(stream);
  }

  /**
   * Clear all state
   */
  public clearAll(): void {
    this._logStreams.clear();
    this._taskGroups.clear();
    this._outputFiles.clear();
    this._missingOutputs.clear();
    this._taskStates.clear();
    this._usageStats.clear();
    this._activeStream = '';
  }
}
