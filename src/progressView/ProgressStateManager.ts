// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { AgentLogger } from '@logger/AgentLogger';
import { StreamTabs } from './managers/StreamTabs';
import { TaskGroups } from './managers/TaskGroups';
import { OutputFiles } from './managers/OutputFiles';
import { TaskStates } from './managers/TaskStates';
import { UsageStats } from './managers/UsageStats';

// Types
import { TokenUsageStats } from '../types/UsageTypes';

interface ColoredLogMessage {
  id: string;
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  timestamp: number;
  groupId?: string;
  messageType?: 'default' | 'scratchpad' | 'thinking';
}

/**
 * Manages persistence of progress view state to workspace storage.
 * Handles loading and saving of log streams, groups, output files,
 * task states, and usage statistics.
 */
export class ProgressStateManager {
  private readonly logger: AgentLogger;

  // State collections
  private _streamTabs: StreamTabs = new StreamTabs();
  private _taskGroups: TaskGroups = new TaskGroups();
  private _outputFiles: OutputFiles = new OutputFiles();
  private _taskStates: TaskStates = new TaskStates();
  private _usageStats: UsageStats = new UsageStats();
  private _activeStream: string = '';

  constructor() {
    this.logger = new AgentLogger('ProgressStateManager');
  }

  // Getters for state collections
  get streamTabs(): StreamTabs {
    return this._streamTabs;
  }

  get taskGroups(): TaskGroups {
    return this._taskGroups;
  }

  get outputFiles(): OutputFiles {
    return this._outputFiles;
  }

  get taskStates(): TaskStates {
    return this._taskStates;
  }

  get usageStats(): UsageStats {
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
    this._saveActiveStream();
    this._saveTaskStates();
    this._saveUsageStats();
  }

  private async _loadLogStreams(): Promise<void> {
    await this._streamTabs.load();
  }

  /**
   * Load log groups from storage
   */
  private async _loadTaskGroups(): Promise<void> {
    await this._taskGroups.load();
  }

  /**
   * Load output files and clean up any that no longer exist
   */
  private async _loadOutputFiles(): Promise<void> {
    await this._outputFiles.load();
  }

  /**
   * Load active stream
   */
  private _loadActiveStream(): void {
    const savedActiveStream = workspaceSM.get<string>(
      WorkspaceStateKey.ACTIVE_LOG_STREAM,
    );
    if (savedActiveStream && this._streamTabs.has(savedActiveStream)) {
      this._activeStream = savedActiveStream;
    } else {
      this._activeStream = Array.from(this._streamTabs.keys())[0] ?? '';
    }
  }

  /**
   * Load task states
   */
  private async _loadTaskStates(): Promise<void> {
    await this._taskStates.load();
  }

  /**
   * Load usage statistics
   */
  private async _loadUsageStats(): Promise<void> {
    await this._usageStats.load();
  }

  /**
   * Save log streams to storage
   */
  private _saveLogStreams(): void {
    this._streamTabs.save();
  }

  /**
   * Save log groups to storage
   */
  private _saveTaskGroups(): void {
    this._taskGroups.save();
  }

  /**
   * Save output files to storage
   */
  private _saveOutputFiles(): void {
    this._outputFiles.save();
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
    this._taskStates.save();
  }

  /**
   * Save usage statistics
   */
  private _saveUsageStats(): void {
    this._usageStats.save();
  }

  /**
   * Clear all state for a specific stream
   */
  public clearStream(stream: string): void {
    this._streamTabs.delete(stream);
    this._taskGroups.delete(stream);
    this._outputFiles.delete(stream);
    this._taskStates.delete(stream);
    this._usageStats.delete(stream);
  }

  /**
   * Clear all state
   */
  public clearAll(): void {
    this._streamTabs.clear();
    this._taskGroups.clear();
    this._outputFiles.clear();
    this._taskStates.clear();
    this._usageStats.clear();
    this._activeStream = '';
  }
}
