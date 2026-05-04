// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

// Local imports
import {
  AgentDirectoryService,
  GlobalStorageAgentDirectoryStorage,
} from '@agent/index';
import type { AgentSource } from '@agent/index';
import { showLoggedMessageWithDocs } from '@common/errors';
import { GlobalStateKey, globalSM } from '@common/state';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

const CHANNEL = 'AgentLoad';
logger.initialize(CHANNEL);

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
  private directoryService: AgentDirectoryService | undefined;
  private watcherDisposables: vscode.FileSystemWatcher[] = [];
  private watcherSubscriptions = new Set<AgentDirectoryWatcherSubscription>();
  private watcherDirectories: Array<{
    directory: string;
    source: AgentSource;
  }> | null = null;
  private watcherSetupPromise: Promise<void> | null = null;

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.directoryService = new AgentDirectoryService({
      storage: new GlobalStorageAgentDirectoryStorage(),
      customDirectoryStore: {
        get: () => globalSM?.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, ''),
      },
      absoluteDirectories: {
        exists: (target) => AbsoluteFS.exists(target),
        ensureDir: (target) => AbsoluteFS.ensureDir(target),
      },
      issueReporter: {
        report: (message, docsId) =>
          showLoggedMessageWithDocs(CHANNEL, message, docsId),
      },
      logger: {
        debug: (message) => logger.debug(CHANNEL, message),
        error: (message) => logger.error(CHANNEL, message),
      },
    });
  }

  private getDirectoryService(): AgentDirectoryService {
    if (!this.context || !this.directoryService) {
      throw new Error(
        'Agent directories not initialized. Call agentDirectories.initialize(context) first.',
      );
    }
    return this.directoryService;
  }

  async builtIn(): Promise<string> {
    return this.getDirectoryService().builtIn();
  }

  async builtInToolUse(): Promise<string> {
    return this.getDirectoryService().builtInToolUse();
  }

  /**
   * Get the directory for a given source type.
   * Returns undefined for Remote sources (which have no local directory).
   */
  async getDirectory(source: AgentSource): Promise<string | undefined> {
    return this.getDirectoryService().getDirectory(source);
  }

  /**
   * Get all local agent directories (excludes Remote).
   * Returns directories in priority order: Custom, BuiltIn, BuiltInToolUse.
   */
  async getAllLocal(): Promise<
    Array<{ directory: string; source: AgentSource }>
  > {
    return this.getDirectoryService().getAllLocal();
  }

  async custom(): Promise<string> {
    return this.getDirectoryService().custom();
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

    await globalSM.update(GlobalStateKey.CUSTOM_AGENT_DIR, selectedPath);

    return selectedPath;
  }

  watchAgentDirectories(
    options: AgentDirectoryWatcherOptions,
  ): vscode.Disposable {
    this.getDirectoryService();
    const pattern = options.pattern ?? '**/*';
    const subscription: AgentDirectoryWatcherSubscription = {
      pattern,
      handleEvent: (event) => {
        // relativePath is already normalized to forward slashes in dispatchAgentEvent
        if (minimatch(event.relativePath, pattern, { dot: true })) {
          options.onEvent(event);
        }
      },
    };

    this.watcherSubscriptions.add(subscription);
    void this.ensureAgentWatchers();

    return {
      dispose: () => {
        this.watcherSubscriptions.delete(subscription);
        if (this.watcherSubscriptions.size === 0) {
          this.disposeAgentWatchers();
        }
      },
    };
  }

  /**
   * Refresh file watchers after the custom agent directory changes.
   * Called by the settings view after updating CUSTOM_AGENT_DIR in globalSM.
   */
  async refreshAfterDirChange(): Promise<void> {
    if (this.watcherSubscriptions.size > 0) {
      await this.ensureAgentWatchers();
    }
  }

  private sameDirectories(
    current: Array<{ directory: string; source: AgentSource }>,
    next: Array<{ directory: string; source: AgentSource }>,
  ): boolean {
    return (
      current.length === next.length &&
      current.every(
        (entry, i) =>
          entry.directory === next[i].directory &&
          entry.source === next[i].source,
      )
    );
  }

  private async ensureAgentWatchers(): Promise<void> {
    // Wait for any in-progress setup to complete
    if (this.watcherSetupPromise) {
      await this.watcherSetupPromise;
      return; // After waiting, watchers are set up - no need to rebuild
    }

    // Set promise immediately to prevent concurrent callers from proceeding
    let resolveSetup: () => void;
    this.watcherSetupPromise = new Promise((resolve) => {
      resolveSetup = resolve;
    });

    try {
      const directories = await this.getAllLocal();
      if (
        this.watcherDirectories &&
        this.sameDirectories(this.watcherDirectories, directories)
      ) {
        return;
      }

      this.buildAgentWatchers(directories);
    } finally {
      resolveSetup!();
      this.watcherSetupPromise = null;
    }
  }

  private buildAgentWatchers(
    directories: Array<{ directory: string; source: AgentSource }>,
  ): void {
    // Dispose old watchers
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
  }

  private dispatchAgentEvent(
    entry: { directory: string; source: AgentSource },
    type: AgentDirectoryEventType,
    uri: vscode.Uri,
  ): void {
    // Normalize to forward slashes for cross-platform consistency.
    // path.relative() returns backslashes on Windows, but minimatch
    // and downstream consumers expect forward slashes.
    const relativePath = path
      .relative(entry.directory, uri.fsPath)
      .replaceAll('\\', '/');
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
   * Dispose all file system watchers.
   * Used when all subscriptions are removed.
   */
  private disposeAgentWatchers(): void {
    this.watcherDisposables.forEach((watcher) => watcher.dispose());
    this.watcherDisposables = [];
    this.watcherDirectories = null;
    this.watcherSetupPromise = null;
  }
}

export const agentDirectories = new AgentDirectoryManager();
