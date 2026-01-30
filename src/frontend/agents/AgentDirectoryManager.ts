// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import type { AgentSource } from '@agent/index';
// Local imports - common
import { showLoggedMessageWithDocs, toErrorMessage } from '@common/errors';
// Local imports - logger
import * as logger from '@logger/logUtils';
// Local imports - utils
import { getConfig, updateConfig } from '@utils/config';
import { debounce } from '@utils/core';
import { GlobalStorageFS, StorageFS, AbsoluteFS } from '@utils/files';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);
const DEFAULT_CUSTOM_AGENTS_DIR_NAME = 'custom_agents';

export class AgentDirectoryManager {
  private context: vscode.ExtensionContext | undefined;
  private watcherEntries = new Map<string, WatcherEntry>();

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

  registerWatcher(options: AgentDirectoryWatchOptions): vscode.Disposable {
    this.ensureInitialized();

    const entry = this.getWatcherEntry(options.pattern);
    const debouncedHandler = debounce(
      (event: AgentDirectoryWatchEvent) => options.onEvent(event),
      options.debounceMs ?? 0,
    );
    const subscriber: WatcherSubscriber = {
      debouncedHandler,
    };
    entry.subscribers.add(subscriber);
    void this.ensureWatchers(entry);

    return {
      dispose: () => {
        entry.subscribers.delete(subscriber);
        if (entry.subscribers.size === 0) {
          this.disposeWatchers(entry);
          this.watcherEntries.delete(entry.pattern);
        }
      },
    };
  }

  async refreshWatchers(): Promise<void> {
    const entries = [...this.watcherEntries.values()];
    for (const entry of entries) {
      await this.ensureWatchers(entry);
    }
  }

  private getWatcherEntry(pattern: string): WatcherEntry {
    const existing = this.watcherEntries.get(pattern);
    if (existing) return existing;

    const entry: WatcherEntry = {
      pattern,
      watchers: [],
      watchPaths: [],
      subscribers: new Set(),
    };
    this.watcherEntries.set(pattern, entry);
    return entry;
  }

  private async ensureWatchers(entry: WatcherEntry): Promise<void> {
    const directories = await this.getAllLocal();
    const watchPaths = directories.map((dir) => dir.directory).filter(Boolean);

    if (this.areWatchPathsEqual(entry.watchPaths, watchPaths)) {
      return;
    }

    this.disposeWatchers(entry);
    entry.watchPaths = watchPaths;

    const dispatch = (event: AgentDirectoryWatchEvent): void => {
      for (const subscriber of entry.subscribers) {
        subscriber.debouncedHandler(event);
      }
    };

    for (const watchPath of watchPaths) {
      const pattern = new vscode.RelativePattern(watchPath, entry.pattern);
      const watcher = vscode.workspace.createFileSystemWatcher(
        pattern,
        false,
        false,
        false,
      );
      entry.watchers.push(watcher);

      watcher.onDidCreate((uri) => dispatch({ type: 'create', uri }));
      watcher.onDidChange((uri) => dispatch({ type: 'change', uri }));
      watcher.onDidDelete((uri) => dispatch({ type: 'delete', uri }));
    }
  }

  private disposeWatchers(entry: WatcherEntry): void {
    entry.watchers.forEach((watcher) => watcher.dispose());
    entry.watchers = [];
    entry.watchPaths = [];
  }

  private areWatchPathsEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((pathValue) => right.includes(pathValue));
  }
}

export const agentDirectories = new AgentDirectoryManager();

interface AgentDirectoryWatchEvent {
  type: 'create' | 'change' | 'delete';
  uri: vscode.Uri;
}

interface AgentDirectoryWatchOptions {
  pattern: string;
  debounceMs?: number;
  onEvent: (event: AgentDirectoryWatchEvent) => void;
}

interface WatcherSubscriber {
  debouncedHandler: (event: AgentDirectoryWatchEvent) => void;
}

interface WatcherEntry {
  pattern: string;
  watchers: vscode.FileSystemWatcher[];
  watchPaths: string[];
  subscribers: Set<WatcherSubscriber>;
}
