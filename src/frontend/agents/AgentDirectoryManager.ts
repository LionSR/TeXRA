// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

// Local imports
import type { AgentSource } from '@agent/index';
import { showLoggedMessageWithDocs, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getConfig, updateConfig, watchConfig } from '@utils/config';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);
const DEFAULT_CUSTOM_AGENTS_DIR_NAME = 'custom_agents';

type AgentDirectoryEventType = 'create' | 'change' | 'delete';

export interface AgentDirectoryWatcherEvent {
  type: AgentDirectoryEventType;
  uri: vscode.Uri;
  relativePath: string;
  directory: string;
  source: AgentSource;
}

export interface AgentDirectoryWatcherOptions {
  pattern?: string;
  onEvent: (event: AgentDirectoryWatcherEvent) => void;
}

interface AgentDirectoryWatcherSubscription {
  pattern: string;
  handleEvent: (event: AgentDirectoryWatcherEvent) => void;
}

export class AgentDirectoryManager {
  private context: vscode.ExtensionContext | undefined;
  private watcherDisposables: vscode.FileSystemWatcher[] = [];
  private watcherSubscriptions = new Set<AgentDirectoryWatcherSubscription>();
  private watcherConfigDisposable: vscode.Disposable | null = null;
  private watcherDirectories: Array<{
    directory: string;
    source: AgentSource;
  }> | null = null;
  private watcherSetupPromise: Promise<void> | null = null;

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    StorageFS.initialize(context);
  }

  private ensureInitialized(): void {
    if (!this.context) {
      throw new Error(
        'Agent directories not initialized. Call agentDirectories.initialize(context) first.',
      );
    }
  }

  private async ensureBuiltInDir(dirName: string): Promise<string> {
    this.ensureInitialized();
    await GlobalStorageFS.ensureDir(dirName);
    const basePath = GlobalStorageFS.fullPath(dirName);
    logger.debug(CHANNEL, `Using built-in ${dirName} directory: ${basePath}`);
    return basePath;
  }

  async builtIn(): Promise<string> {
    return this.ensureBuiltInDir('agents');
  }

  async builtInToolUse(): Promise<string> {
    return this.ensureBuiltInDir('tool_use_agents');
  }

  /**
   * Get the directory for a given source type.
   * Returns undefined for Remote sources (which have no local directory).
   */
  async getDirectory(source: AgentSource): Promise<string | undefined> {
    switch (source) {
      case 'custom':
        return this.custom();
      case 'builtIn':
        return this.builtIn();
      case 'builtInToolUse':
        return this.builtInToolUse();
      case 'remote':
        return undefined;
    }
  }

  /**
   * Get all local agent directories (excludes Remote).
   * Returns directories in priority order: Custom, BuiltIn, BuiltInToolUse.
   */
  async getAllLocal(): Promise<
    Array<{ directory: string; source: AgentSource }>
  > {
    const [customDir, builtInDir, builtInToolUseDir] = await Promise.all([
      this.custom(),
      this.builtIn(),
      this.builtInToolUse(),
    ]);

    return [
      { directory: customDir, source: 'custom' },
      { directory: builtInDir, source: 'builtIn' },
      { directory: builtInToolUseDir, source: 'builtInToolUse' },
    ];
  }

  private async ensureDefaultCustomDir(): Promise<string> {
    this.ensureInitialized();

    try {
      await GlobalStorageFS.ensureDir(DEFAULT_CUSTOM_AGENTS_DIR_NAME);
    } catch (error) {
      const message = toErrorMessage(error);
      logger.error(
        CHANNEL,
        `Failed to create default custom agents directory: ${message}`,
      );
      throw new Error(
        'Unable to create custom agents directory. Please check permissions.',
      );
    }

    const defaultPath = GlobalStorageFS.fullPath(
      DEFAULT_CUSTOM_AGENTS_DIR_NAME,
    );
    logger.debug(
      CHANNEL,
      `Using default custom agents directory: ${defaultPath}`,
    );
    return defaultPath;
  }

  private async resolveConfiguredCustomDir(
    configuredPath: string,
  ): Promise<string | undefined> {
    if (!configuredPath) {
      return undefined;
    }

    if (!path.isAbsolute(configuredPath)) {
      logger.error(
        CHANNEL,
        `Custom agents directory must be an absolute path: ${configuredPath}`,
      );
      await showLoggedMessageWithDocs(
        CHANNEL,
        'Custom agents directory must be an absolute path',
        'custom-agents',
      );
      return undefined;
    }

    const parentDir = path.dirname(configuredPath);
    const parentExists = await AbsoluteFS.exists(parentDir);
    if (!parentExists) {
      logger.error(
        CHANNEL,
        `Parent directory does not exist for custom agents directory: ${parentDir}`,
      );
      await showLoggedMessageWithDocs(
        CHANNEL,
        'Parent directory for custom agents directory does not exist',
        'custom-agents',
      );
      return undefined;
    }

    await AbsoluteFS.ensureDir(configuredPath);
    logger.debug(
      CHANNEL,
      `Using custom agents directory from setting: ${configuredPath}`,
    );
    return configuredPath;
  }

  async custom(): Promise<string> {
    this.ensureInitialized();
    const configuredPath = getConfig<string>(
      'texra.explorer.agentsDirectory',
      '',
    ).trim();

    const resolvedPath = await this.resolveConfiguredCustomDir(configuredPath);
    if (resolvedPath) {
      return resolvedPath;
    }

    return this.ensureDefaultCustomDir();
  }

  async promptCustom(): Promise<string | undefined> {
    const folder = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Folder',
    });

    if (!folder || folder.length === 0) {
      return undefined;
    }

    const selectedPath = folder[0].fsPath;
    await AbsoluteFS.ensureDir(selectedPath);

    await updateConfig('texra.explorer.agentsDirectory', selectedPath, {
      prefix: false,
    });

    return selectedPath;
  }

  watchAgentDirectories(
    options: AgentDirectoryWatcherOptions,
  ): vscode.Disposable {
    this.ensureInitialized();
    const pattern = options.pattern ?? '**/*';
    const subscription: AgentDirectoryWatcherSubscription = {
      pattern,
      handleEvent: (event) => {
        if (minimatch(event.relativePath, pattern, { dot: true })) {
          options.onEvent(event);
        }
      },
    };

    this.watcherSubscriptions.add(subscription);
    void this.ensureAgentWatchers();
    this.ensureAgentDirectoryWatcherConfig();

    return {
      dispose: () => {
        this.watcherSubscriptions.delete(subscription);
        if (this.watcherSubscriptions.size === 0) {
          this.disposeAgentWatchers();
        }
      },
    };
  }

  private ensureAgentDirectoryWatcherConfig(): void {
    if (this.watcherConfigDisposable || !this.context) {
      return;
    }

    this.watcherConfigDisposable = watchConfig(
      this.context,
      'texra.explorer.agentsDirectory',
      () => {
        void this.refreshAgentWatchers();
      },
    );
  }

  private sameDirectories(
    current: Array<{ directory: string; source: AgentSource }>,
    next: Array<{ directory: string; source: AgentSource }>,
  ): boolean {
    if (current.length !== next.length) return false;
    return current.every(
      (entry, index) =>
        entry.directory === next[index].directory &&
        entry.source === next[index].source,
    );
  }

  private async ensureAgentWatchers(): Promise<void> {
    // Wait for any in-progress setup to complete
    while (this.watcherSetupPromise) {
      await this.watcherSetupPromise;
    }

    const directories = await this.getAllLocal();
    if (
      this.watcherDirectories &&
      this.sameDirectories(this.watcherDirectories, directories)
    ) {
      return;
    }

    await this.buildAgentWatchers(directories);
  }

  private async refreshAgentWatchers(): Promise<void> {
    if (this.watcherSubscriptions.size === 0) {
      return;
    }
    await this.ensureAgentWatchers();
  }

  private async buildAgentWatchers(
    directories: Array<{ directory: string; source: AgentSource }>,
  ): Promise<void> {
    // Create a deferred promise to prevent race conditions.
    // Set the promise synchronously BEFORE disposing old watchers.
    let resolveSetup: () => void;
    this.watcherSetupPromise = new Promise((resolve) => {
      resolveSetup = resolve;
    });

    // Now safe to dispose old watchers
    this.watcherDisposables.forEach((watcher) => watcher.dispose());
    this.watcherDisposables = [];
    this.watcherDirectories = directories;

    for (const entry of directories) {
      const pattern = new vscode.RelativePattern(entry.directory, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(
        pattern,
        false,
        false,
        false,
      );
      this.watcherDisposables.push(watcher);

      const dispatch = (type: AgentDirectoryEventType) => (uri: vscode.Uri) =>
        this.dispatchAgentEvent(entry, type, uri);

      watcher.onDidCreate(dispatch('create'));
      watcher.onDidChange(dispatch('change'));
      watcher.onDidDelete(dispatch('delete'));
    }

    logger.info(
      CHANNEL,
      `Agent directory watchers enabled: ${directories
        .map((dir) => dir.directory)
        .join(', ')}`,
    );

    // Signal completion then clear the promise
    // Order matters: resolve first so waiters see directories set before promise clears
    resolveSetup!();
    this.watcherSetupPromise = null;
  }

  private dispatchAgentEvent(
    entry: { directory: string; source: AgentSource },
    type: AgentDirectoryEventType,
    uri: vscode.Uri,
  ): void {
    const relativePath = path.relative(entry.directory, uri.fsPath);
    const event: AgentDirectoryWatcherEvent = {
      type,
      uri,
      relativePath,
      directory: entry.directory,
      source: entry.source,
    };

    for (const subscription of this.watcherSubscriptions) {
      subscription.handleEvent(event);
    }
  }

  /**
   * Dispose only the file system watchers, preserving config watcher.
   * Used during rebuilds when directories change.
   */
  private disposeFileWatchers(): void {
    this.watcherDisposables.forEach((watcher) => watcher.dispose());
    this.watcherDisposables = [];
    this.watcherDirectories = null;
    this.watcherSetupPromise = null;
  }

  /**
   * Dispose all watchers including the config listener.
   * Used when all subscriptions are removed.
   */
  private disposeAgentWatchers(): void {
    this.disposeFileWatchers();
    if (this.watcherConfigDisposable) {
      this.watcherConfigDisposable.dispose();
      this.watcherConfigDisposable = null;
    }
  }
}

export const agentDirectories = new AgentDirectoryManager();
