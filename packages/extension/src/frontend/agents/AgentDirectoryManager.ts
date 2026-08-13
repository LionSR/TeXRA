// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import PQueue from 'p-queue';

// Local imports
import type {
  AgentDirectoryEntry,
  AgentDirectoryService,
  AgentSource,
} from '@agent/index';
import { createPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { globalSM } from '@common/state';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { AGENT_SOURCE } from '@shared/schemas/agent';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'AgentLoad';

type AgentDirectoryEventType = 'create' | 'change' | 'delete';

interface AgentDirectoryWatcherEvent extends AgentDirectoryEntry {
  type: AgentDirectoryEventType;
  uri: vscode.Uri;
  relativePath: string;
}

interface AgentDirectoryWatcherOptions {
  pattern?: string;
  onEvent: (event: AgentDirectoryWatcherEvent) => void;
}

interface AgentDirectoryWatcherSubscription {
  pattern: string;
  handleEvent: (event: AgentDirectoryWatcherEvent) => void;
}

class AgentDirectoryManager {
  private context: vscode.ExtensionContext | undefined;
  private directoryService: AgentDirectoryService | undefined;
  private watcherDisposables: vscode.Disposable[] = [];
  private watcherSubscriptions = new Set<AgentDirectoryWatcherSubscription>();
  private externalWatcherDirectoryPaths = new Set<string>();
  private watcherDirectories: AgentDirectoryEntry[] | null = null;
  private readonly watcherRebuilds = new PQueue({ concurrency: 1 });

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.directoryService = createPlatformAgentDirectories({
      channel: CHANNEL,
      customDirectoryStore: {
        get: () => globalSM?.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, ''),
      },
      issueReporter: {
        report: (message, docsId) =>
          showLoggedMessageWithDocs(CHANNEL, message, docsId),
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
  async getAllLocal(): Promise<AgentDirectoryEntry[]> {
    return this.getDirectoryService().getAllLocal();
  }

  async custom(): Promise<string> {
    return this.getDirectoryService().custom();
  }

  async promptCustom(): Promise<string | undefined> {
    const selectedPath = await selectFolder({ openLabel: 'Select Folder' });
    if (!selectedPath) {
      return undefined;
    }

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
    this.scheduleAgentWatcherSetup();

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
    current: AgentDirectoryEntry[],
    next: AgentDirectoryEntry[],
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

  /**
   * The rebuild queue is the only writer of the watcher set and of the cached
   * directory list. One rebuild runs at a time and at most one waits behind
   * it: a request arriving while a rebuild runs is answered by the waiting
   * one, which reads the directory list after the running rebuild has settled.
   * Disposal never discards queued rebuilds, so every caller awaiting one
   * settles; a rebuild that starts with no subscriptions left has nothing to
   * watch and returns.
   */
  private async ensureAgentWatchers(): Promise<void> {
    if (this.watcherRebuilds.size > 0) {
      await this.watcherRebuilds.onIdle();
      return;
    }

    await this.watcherRebuilds.add(async () => {
      if (this.watcherSubscriptions.size === 0) {
        return;
      }

      const directories = await this.getAllLocal();
      if (this.watcherSubscriptions.size === 0) {
        return;
      }
      const cached = this.watcherDirectories;
      this.watcherDirectories = directories;
      if (cached && this.sameDirectories(cached, directories)) {
        return;
      }

      await this.buildAgentWatchers(directories);
      if (this.watcherSubscriptions.size === 0) {
        this.disposeAgentWatchers();
      }
    });
  }

  private async buildAgentWatchers(
    directories: AgentDirectoryEntry[],
  ): Promise<void> {
    // Dispose old watchers
    const previousExternalWatcherDirectoryPaths = new Set(
      this.externalWatcherDirectoryPaths,
    );
    this.watcherDisposables.forEach((watcher) => watcher.dispose());
    this.watcherDisposables = [];
    this.externalWatcherDirectoryPaths.clear();

    const watchedDirectories: string[] = [];
    const skippedDirectories: string[] = [];

    for (const entry of directories) {
      const directoryUri = vscode.Uri.file(entry.directory);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(directoryUri);

      if (workspaceFolder) {
        this.watchDirectoryTree(entry, directoryUri, '**/*');
        watchedDirectories.push(entry.directory);
        continue;
      }

      if (entry.source !== AGENT_SOURCE.CUSTOM) {
        skippedDirectories.push(entry.directory);
        continue;
      }

      await this.watchExternalCustomDirectory(
        entry,
        directoryUri,
        previousExternalWatcherDirectoryPaths,
      );
      watchedDirectories.push(entry.directory);
    }

    logger.info(
      CHANNEL,
      `Agent directory watchers enabled: ${watchedDirectories.join(', ')}`,
    );

    if (skippedDirectories.length > 0) {
      logger.debug(
        CHANNEL,
        `Skipped external built-in agent directory watchers: ${skippedDirectories.join(', ')}`,
      );
    }
  }

  private watchDirectoryTree(
    entry: AgentDirectoryEntry,
    directoryUri: vscode.Uri,
    pattern: string,
    onCreateOrDelete?: (
      type: 'create' | 'delete',
      uri: vscode.Uri,
    ) => void | Promise<void>,
  ): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(directoryUri, pattern),
      false,
      false,
      false,
    );
    this.watcherDisposables.push(watcher);

    watcher.onDidCreate((uri) => {
      this.dispatchAgentEvent(entry, 'create', uri);
      void onCreateOrDelete?.('create', uri);
    });
    watcher.onDidChange((uri) => this.dispatchAgentEvent(entry, 'change', uri));
    watcher.onDidDelete((uri) => {
      this.dispatchAgentEvent(entry, 'delete', uri);
      void onCreateOrDelete?.('delete', uri);
    });
  }

  private async watchExternalCustomDirectory(
    entry: AgentDirectoryEntry,
    directoryUri: vscode.Uri,
    previousDirectoryPaths: ReadonlySet<string>,
  ): Promise<void> {
    const directories = await this.collectDirectoryUris(directoryUri);
    const newlyWatchedDirectories: vscode.Uri[] = [];

    for (const dirUri of directories) {
      const normalizedDirectoryPath = this.normalizeFsPath(dirUri.fsPath);
      if (
        previousDirectoryPaths.size > 0 &&
        !previousDirectoryPaths.has(normalizedDirectoryPath)
      ) {
        newlyWatchedDirectories.push(dirUri);
      }
      this.externalWatcherDirectoryPaths.add(normalizedDirectoryPath);
      this.watchDirectoryTree(entry, dirUri, '*', (type, uri) =>
        this.handleExternalDirectoryTreeChange(type, uri),
      );
    }

    await this.dispatchExistingYamlFiles(entry, newlyWatchedDirectories);
  }

  private async collectDirectoryUris(root: vscode.Uri): Promise<vscode.Uri[]> {
    const directories: vscode.Uri[] = [];
    const pending: vscode.Uri[] = [root];
    const visitedRealPaths = new Set<string>();

    for (let i = 0; i < pending.length; i++) {
      const uri = pending[i];
      const realPath = await this.realDirectoryPath(uri);
      if (visitedRealPaths.has(realPath)) {
        continue;
      }

      visitedRealPaths.add(realPath);
      directories.push(uri);

      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch (error) {
        logger.debug(
          CHANNEL,
          `Unable to scan agent directory ${uri.fsPath}: ${toErrorMessage(error)}`,
        );
        continue;
      }

      for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) !== 0) {
          pending.push(vscode.Uri.joinPath(uri, name));
        }
      }
    }

    return directories;
  }

  private async handleExternalDirectoryTreeChange(
    type: 'create' | 'delete',
    uri: vscode.Uri,
  ): Promise<void> {
    if (type === 'create') {
      if (await this.isDirectoryUri(uri)) {
        this.requestAgentWatcherRebuild();
      }
      return;
    }

    if (
      this.externalWatcherDirectoryPaths.has(this.normalizeFsPath(uri.fsPath))
    ) {
      this.requestAgentWatcherRebuild();
    }
  }

  /**
   * Clearing the cached list is what forces the next queued rebuild to do real
   * work. The only write that can overwrite the cleared list is the running
   * rebuild's own commit, which happens before that rebuild scans directory
   * trees, so a request lost that way is one whose change the scan still sees.
   */
  private requestAgentWatcherRebuild(): void {
    this.watcherDirectories = null;
    this.scheduleAgentWatcherSetup();
  }

  private async dispatchExistingYamlFiles(
    entry: AgentDirectoryEntry,
    directories: readonly vscode.Uri[],
  ): Promise<void> {
    for (const directory of directories) {
      let files: [string, vscode.FileType][];
      try {
        files = await vscode.workspace.fs.readDirectory(directory);
      } catch (error) {
        logger.debug(
          CHANNEL,
          `Unable to scan new agent directory ${directory.fsPath}: ${toErrorMessage(error)}`,
        );
        continue;
      }

      for (const [name, type] of files) {
        if ((type & vscode.FileType.File) !== 0 && name.endsWith('.yaml')) {
          this.dispatchAgentEvent(
            entry,
            'create',
            vscode.Uri.joinPath(directory, name),
          );
        }
      }
    }
  }

  private scheduleAgentWatcherSetup(): void {
    void this.ensureAgentWatchers().catch((error) => {
      logger.error(
        CHANNEL,
        `Failed to refresh agent directory watchers: ${toErrorMessage(error)}`,
      );
    });
  }

  private async isDirectoryUri(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }

  private async realDirectoryPath(uri: vscode.Uri): Promise<string> {
    try {
      return await fs.realpath(uri.fsPath);
    } catch {
      return this.normalizeFsPath(uri.fsPath);
    }
  }

  private normalizeFsPath(fsPath: string): string {
    return path.resolve(fsPath);
  }

  private dispatchAgentEvent(
    entry: AgentDirectoryEntry,
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
    this.externalWatcherDirectoryPaths.clear();
    this.watcherDirectories = null;
  }
}

export const agentDirectories = new AgentDirectoryManager();
