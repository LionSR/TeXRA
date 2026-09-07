// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Cause, Effect, Exit } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  type AgentDirectoryEntry,
  type AgentDirectoryService,
  type AgentSource,
  createPlatformAgentDirectories,
} from '@agent/index';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import { selectFolder } from '@frontend/ui/dialogs';
import { createLog } from '@logger/logUtils';
import { platform, tryGlobalState } from '@platform/platform';
import { effectRuntime } from '@platform/processRuntime';
import { AGENT_SOURCE } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'AgentLoad';
const log = createLog(CHANNEL);

const AGENT_WATCHER_REBUILD_LANE = 'agent-watcher-rebuild';

/**
 * Settle one watcher-lane Effect back to this module's Promise surface: the
 * `Exit` fold re-throws the original error, as the queued rebuild did.
 */
async function runSettledEffect<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> {
  const exit = await effectRuntime().runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

class AgentDirectoryManager {
  private directoryService: AgentDirectoryService | undefined;
  private watcherDisposables: vscode.Disposable[] = [];
  /** The single watcher subscriber; `undefined` means nobody is listening. */
  private onAgentYamlChange: (() => void) | undefined;
  private externalWatcherDirectoryPaths = new Set<string>();
  private watcherDirectories: AgentDirectoryEntry[] | null = null;
  private readonly watcherRebuildLanes = new Map<string, PerKeyLane>();

  initialize(): void {
    this.directoryService = createPlatformAgentDirectories({
      channel: CHANNEL,
      customDirectoryStore: {
        get: () =>
          tryGlobalState()?.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, '') ??
          '',
      },
      issueReporter: {
        report: (message, docsId) =>
          showLoggedMessageWithDocs(CHANNEL, message, docsId),
      },
    });
  }

  private getDirectoryService(): AgentDirectoryService {
    if (!this.directoryService) {
      throw new Error(
        'Agent directories not initialized. Call agentDirectories.initialize() first.',
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

  async custom(): Promise<string> {
    return this.getDirectoryService().custom();
  }

  async promptCustom(): Promise<string | undefined> {
    const selectedPath = await selectFolder({ openLabel: 'Select Folder' });
    if (!selectedPath) {
      return undefined;
    }

    await AbsoluteFS.ensureDir(selectedPath);

    await platform().globalState.update(
      GlobalStateKey.CUSTOM_AGENT_DIR,
      selectedPath,
    );

    return selectedPath;
  }

  /**
   * Watch every local agent directory and call `onChange` whenever an agent
   * YAML file is created, changed or deleted. One subscriber at a time —
   * re-subscribing replaces the previous callback.
   */
  watchAgentDirectories(onChange: () => void): vscode.Disposable {
    this.getDirectoryService();
    this.onAgentYamlChange = onChange;
    this.scheduleAgentWatcherSetup();

    return {
      dispose: () => {
        this.onAgentYamlChange = undefined;
        this.disposeAgentWatchers();
      },
    };
  }

  /**
   * Refresh file watchers after the custom agent directory changes.
   * Called by the settings view after updating CUSTOM_AGENT_DIR in global state.
   */
  async refreshAfterDirChange(): Promise<void> {
    if (this.onAgentYamlChange) {
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
   * The rebuild lane is the only writer of the watcher set and of the cached
   * directory list. One rebuild runs at a time and at most one waits behind
   * it: a request arriving while a rebuild runs is answered by the waiting
   * one, which reads the directory list after the running rebuild has settled.
   * A claimed lane is never discarded, so every caller awaiting one settles;
   * a rebuild that starts with no subscriber left has nothing to watch and
   * returns.
   */
  private async ensureAgentWatchers(): Promise<void> {
    const lane = this.watcherRebuildLanes.get(AGENT_WATCHER_REBUILD_LANE);
    if (lane && lane.fibers > 1) {
      // A rebuild is running and another is already waiting behind it, so the
      // waiting one answers this request too. Claim the lane with no work to
      // wait for both — what awaiting the queue's idle did.
      await runSettledEffect(
        withPerKeyLane(
          this.watcherRebuildLanes,
          AGENT_WATCHER_REBUILD_LANE,
        )(Effect.void),
      );
      return;
    }

    await runSettledEffect(
      withPerKeyLane(
        this.watcherRebuildLanes,
        AGENT_WATCHER_REBUILD_LANE,
      )(
        Effect.tryPromise({
          try: () => this.rebuildAgentWatchers(),
          catch: (error) => error,
        }),
      ),
    );
  }

  private async rebuildAgentWatchers(): Promise<void> {
    if (!this.onAgentYamlChange) {
      return;
    }

    const directories = await this.getDirectoryService().getAllLocal();
    if (!this.onAgentYamlChange) {
      return;
    }
    const cached = this.watcherDirectories;
    this.watcherDirectories = directories;
    if (cached && this.sameDirectories(cached, directories)) {
      return;
    }

    await this.buildAgentWatchers(directories);
    if (!this.onAgentYamlChange) {
      this.disposeAgentWatchers();
    }
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
        this.watchDirectoryTree(directoryUri, '**/*');
        watchedDirectories.push(entry.directory);
        continue;
      }

      if (entry.source !== AGENT_SOURCE.CUSTOM) {
        skippedDirectories.push(entry.directory);
        continue;
      }

      await this.watchExternalCustomDirectory(
        directoryUri,
        previousExternalWatcherDirectoryPaths,
      );
      watchedDirectories.push(entry.directory);
    }

    log.info(
      `Agent directory watchers enabled: ${watchedDirectories.join(', ')}`,
    );

    if (skippedDirectories.length > 0) {
      log.debug(
        `Skipped external built-in agent directory watchers: ${skippedDirectories.join(', ')}`,
      );
    }
  }

  /**
   * The watcher pattern stays unfiltered: directory create/delete events must
   * keep reaching `onCreateOrDelete`, which is what drives the rebuild. The
   * `.yaml` filter belongs at the subscriber edge, in `notifyAgentYamlChange`.
   */
  private watchDirectoryTree(
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
      this.notifyAgentYamlChange(uri);
      void onCreateOrDelete?.('create', uri);
    });
    watcher.onDidChange((uri) => this.notifyAgentYamlChange(uri));
    watcher.onDidDelete((uri) => {
      this.notifyAgentYamlChange(uri);
      void onCreateOrDelete?.('delete', uri);
    });
  }

  private async watchExternalCustomDirectory(
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
      this.watchDirectoryTree(dirUri, '*', (type, uri) =>
        this.handleExternalDirectoryTreeChange(type, uri),
      );
    }

    await this.dispatchExistingYamlFiles(newlyWatchedDirectories);
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

      const listed = await effectRuntime().runPromiseExit(
        Effect.tryPromise({
          try: () => vscode.workspace.fs.readDirectory(uri),
          catch: (error) => error,
        }),
      );
      if (Exit.isFailure(listed)) {
        log.debug(
          `Unable to scan agent directory ${uri.fsPath}: ${toErrorMessage(Cause.squash(listed.cause))}`,
        );
        continue;
      }
      const entries = listed.value;

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
    directories: readonly vscode.Uri[],
  ): Promise<void> {
    for (const directory of directories) {
      const listed = await effectRuntime().runPromiseExit(
        Effect.tryPromise({
          try: () => vscode.workspace.fs.readDirectory(directory),
          catch: (error) => error,
        }),
      );
      if (Exit.isFailure(listed)) {
        log.debug(
          `Unable to scan new agent directory ${directory.fsPath}: ${toErrorMessage(Cause.squash(listed.cause))}`,
        );
        continue;
      }

      for (const [name, type] of listed.value) {
        if ((type & vscode.FileType.File) !== 0 && name.endsWith('.yaml')) {
          this.onAgentYamlChange?.();
        }
      }
    }
  }

  private scheduleAgentWatcherSetup(): void {
    effectRuntime().runFork(
      Effect.tryPromise({
        try: () => this.ensureAgentWatchers(),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.error(
              `Failed to refresh agent directory watchers: ${toErrorMessage(error)}`,
            );
          }),
        ),
      ),
    );
  }

  private async isDirectoryUri(uri: vscode.Uri): Promise<boolean> {
    const stat = await effectRuntime().runPromiseExit(
      Effect.tryPromise({
        try: () => vscode.workspace.fs.stat(uri),
        catch: (error) => error,
      }),
    );
    return (
      Exit.isSuccess(stat) &&
      (stat.value.type & vscode.FileType.Directory) !== 0
    );
  }

  private async realDirectoryPath(uri: vscode.Uri): Promise<string> {
    const realPath = await effectRuntime().runPromiseExit(
      Effect.tryPromise({
        try: () => fs.realpath(uri.fsPath),
        catch: (error) => error,
      }),
    );
    return Exit.isSuccess(realPath)
      ? realPath.value
      : this.normalizeFsPath(uri.fsPath);
  }

  private normalizeFsPath(fsPath: string): string {
    return path.resolve(fsPath);
  }

  private notifyAgentYamlChange(uri: vscode.Uri): void {
    if (uri.fsPath.endsWith('.yaml')) {
      this.onAgentYamlChange?.();
    }
  }

  /**
   * Dispose all file system watchers.
   * Used when the subscription is removed.
   */
  private disposeAgentWatchers(): void {
    this.watcherDisposables.forEach((watcher) => watcher.dispose());
    this.watcherDisposables = [];
    this.externalWatcherDirectoryPaths.clear();
    this.watcherDirectories = null;
  }
}

export const agentDirectories = new AgentDirectoryManager();
