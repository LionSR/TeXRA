// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, type PlatformError } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  type AgentDirectoryEntry,
  type AgentDirectoryService,
  type AgentSource,
  agentSourceDirectory,
  createPlatformAgentDirectories,
} from '@agent/index';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import { type OpenDialogFailed, selectFolder } from '@frontend/ui/dialogs';
import { withLogChannel } from '@logger/effectLog';
import { createLog } from '@logger/logUtils';
import {
  type AgentDirectoriesFailed,
  StateWriteFailed,
} from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { AGENT_SOURCE } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'AgentLoad';
const log = createLog(CHANNEL);

const AGENT_WATCHER_REBUILD_LANE = 'agent-watcher-rebuild';

/** The two host services `initialize()` hands the manager, kept together so
 *  one guard covers both. */
interface AgentDirectoryHost {
  readonly directories: AgentDirectoryService;
  readonly globalState: vscode.Memento;
  /** The host entry's process runtime, handed down with the two services. */
  readonly runtime: ProcessRuntime;
}

class AgentDirectoryManager {
  private host: AgentDirectoryHost | undefined;
  private watcherDisposables: vscode.Disposable[] = [];
  /** The single watcher subscriber; `undefined` means nobody is listening. */
  private onAgentYamlChange: (() => void) | undefined;
  private externalWatcherDirectoryPaths = new Set<string>();
  private watcherDirectories: AgentDirectoryEntry[] | null = null;
  private readonly watcherRebuildLanes = new Map<string, PerKeyLane>();

  initialize(
    globalState: vscode.Memento,
    resourcesPath: string,
    runtime: ProcessRuntime,
  ): void {
    this.host = {
      globalState,
      runtime,
      directories: createPlatformAgentDirectories({
        channel: CHANNEL,
        // Built-in agents are read straight out of the installed extension's
        // `resources`, never copied into global storage.
        resourcesPath,
        customDirectoryStore: {
          get: () =>
            globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, ''),
        },
        issueReporter: {
          report: (message, docsId) =>
            showLoggedMessageWithDocs(CHANNEL, message, docsId),
        },
      }),
    };
  }

  private getHost(): AgentDirectoryHost {
    if (!this.host) {
      throw new Error(
        'Agent directories not initialized. Call agentDirectories.initialize() first.',
      );
    }
    return this.host;
  }

  // The four readers below are the platform port's, so they stay `Effect`s:
  // `Effect.suspend` keeps the uninitialized-host guard inside the Effect
  // rather than throwing from a call that is supposed to return a program.
  // A caller that owns a runtime and needs the path outright runs it.

  builtIn(): Effect.Effect<string, AgentDirectoriesFailed> {
    return Effect.suspend(() => this.getHost().directories.builtIn());
  }

  builtInToolUse(): Effect.Effect<string, AgentDirectoriesFailed> {
    return Effect.suspend(() => this.getHost().directories.builtInToolUse());
  }

  /**
   * Get the directory for a given source type.
   * Returns undefined for Remote sources (which have no local directory).
   */
  getDirectory(
    source: AgentSource,
  ): Effect.Effect<
    string | undefined,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.suspend(() =>
      agentSourceDirectory(this.getHost().directories, source),
    );
  }

  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.suspend(() => this.getHost().directories.custom());
  }

  promptCustom(): Effect.Effect<
    string | undefined,
    OpenDialogFailed | PlatformError.PlatformError | StateWriteFailed,
    FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      const selectedPath = yield* selectFolder({ openLabel: 'Select Folder' });
      if (!selectedPath) {
        return undefined;
      }

      // The picked folder is the user's, outside every session root. A
      // directory already there is the post-condition, and a recursive
      // makeDirectory is a no-op on one, so nothing here is recovered: a real
      // fault (the path is a file, the volume is read-only) fails and
      // surfaces instead of writing the setting anyway.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(selectedPath, { recursive: true });

      const key = GlobalStateKey.CUSTOM_AGENT_DIR;
      yield* Effect.tryPromise({
        try: () => this.getHost().globalState.update(key, selectedPath),
        catch: (cause) =>
          new StateWriteFailed({ key, message: toErrorMessage(cause), cause }),
      });

      return selectedPath;
    });
  }

  /**
   * Watch every local agent directory and call `onChange` whenever an agent
   * YAML file is created, changed or deleted. One subscriber at a time —
   * re-subscribing replaces the previous callback.
   */
  watchAgentDirectories(onChange: () => void): vscode.Disposable {
    this.getHost();
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
  refreshAfterDirChange(): Effect.Effect<
    void,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.suspend(() =>
      this.onAgentYamlChange ? this.ensureAgentWatchers() : Effect.void,
    );
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
  private ensureAgentWatchers(): Effect.Effect<
    void,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.suspend(() => {
      const lane = this.watcherRebuildLanes.get(AGENT_WATCHER_REBUILD_LANE);
      const onRebuildLane = withPerKeyLane(
        this.watcherRebuildLanes,
        AGENT_WATCHER_REBUILD_LANE,
      );

      if (lane && lane.fibers > 1) {
        // A rebuild is running and another is already waiting behind it, so the
        // waiting one answers this request too. Claim the lane with no work to
        // wait for both — what awaiting the queue's idle did.
        return onRebuildLane(Effect.void);
      }

      return onRebuildLane(this.rebuildAgentWatchers());
    });
  }

  private rebuildAgentWatchers(): Effect.Effect<
    void,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      if (!this.onAgentYamlChange) {
        return;
      }

      const directories = yield* this.getHost().directories.getAllLocal();
      if (!this.onAgentYamlChange) {
        return;
      }
      const cached = this.watcherDirectories;
      this.watcherDirectories = directories;
      if (cached && this.sameDirectories(cached, directories)) {
        return;
      }

      yield* this.buildAgentWatchers(directories);
      if (!this.onAgentYamlChange) {
        this.disposeAgentWatchers();
      }
    });
  }

  private buildAgentWatchers(
    directories: AgentDirectoryEntry[],
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
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

        if (vscode.workspace.getWorkspaceFolder(directoryUri)) {
          this.watchDirectoryTree(directoryUri, '**/*');
        } else if (entry.source !== AGENT_SOURCE.CUSTOM) {
          skippedDirectories.push(entry.directory);
          continue;
        } else {
          yield* this.watchExternalCustomDirectory(
            directoryUri,
            previousExternalWatcherDirectoryPaths,
          );
        }
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
    });
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
    ) => Effect.Effect<void>,
  ): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(directoryUri, pattern),
      false,
      false,
      false,
    );
    this.watcherDisposables.push(watcher);

    const runOnCreateOrDelete = (
      type: 'create' | 'delete',
      uri: vscode.Uri,
    ) => {
      const program = onCreateOrDelete?.(type, uri);
      if (program) this.getHost().runtime.runFork(program);
    };
    watcher.onDidCreate((uri) => {
      this.notifyAgentYamlChange(uri);
      runOnCreateOrDelete('create', uri);
    });
    watcher.onDidChange((uri) => this.notifyAgentYamlChange(uri));
    watcher.onDidDelete((uri) => {
      this.notifyAgentYamlChange(uri);
      runOnCreateOrDelete('delete', uri);
    });
  }

  private watchExternalCustomDirectory(
    directoryUri: vscode.Uri,
    previousDirectoryPaths: ReadonlySet<string>,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const directories = yield* this.collectDirectoryUris(directoryUri);
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

      yield* this.dispatchExistingYamlFiles(newlyWatchedDirectories);
    });
  }

  private collectDirectoryUris(root: vscode.Uri): Effect.Effect<vscode.Uri[]> {
    return Effect.gen({ self: this }, function* () {
      const directories: vscode.Uri[] = [];
      const pending: vscode.Uri[] = [root];
      const visitedRealPaths = new Set<string>();

      for (let i = 0; i < pending.length; i++) {
        const uri = pending[i];
        const realPath = yield* this.realDirectoryPath(uri);
        if (visitedRealPaths.has(realPath)) {
          continue;
        }

        visitedRealPaths.add(realPath);
        directories.push(uri);

        const entries = yield* Effect.tryPromise({
          try: () => vscode.workspace.fs.readDirectory(uri),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.debug(
                `Unable to scan agent directory ${uri.fsPath}: ${toErrorMessage(error)}`,
              );
              return [] as Array<[string, vscode.FileType]>;
            }),
          ),
        );

        for (const [name, type] of entries) {
          if ((type & vscode.FileType.Directory) !== 0) {
            pending.push(vscode.Uri.joinPath(uri, name));
          }
        }
      }

      return directories;
    });
  }

  private handleExternalDirectoryTreeChange(
    type: 'create' | 'delete',
    uri: vscode.Uri,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (type === 'create') {
        if (yield* this.isDirectoryUri(uri)) {
          this.requestAgentWatcherRebuild();
        }
        return;
      }

      if (
        this.externalWatcherDirectoryPaths.has(this.normalizeFsPath(uri.fsPath))
      ) {
        this.requestAgentWatcherRebuild();
      }
    });
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

  private dispatchExistingYamlFiles(
    directories: readonly vscode.Uri[],
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      for (const directory of directories) {
        const entries = yield* Effect.tryPromise({
          try: () => vscode.workspace.fs.readDirectory(directory),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.debug(
                `Unable to scan new agent directory ${directory.fsPath}: ${toErrorMessage(error)}`,
              );
              return [] as Array<[string, vscode.FileType]>;
            }),
          ),
        );

        for (const [name, type] of entries) {
          if ((type & vscode.FileType.File) !== 0 && name.endsWith('.yaml')) {
            this.onAgentYamlChange?.();
          }
        }
      }
    });
  }

  private scheduleAgentWatcherSetup(): void {
    this.getHost().runtime.runFork(
      this.ensureAgentWatchers().pipe(
        Effect.catch((error) =>
          Effect.logError(
            `Failed to refresh agent directory watchers: ${toErrorMessage(error)}`,
          ).pipe(withLogChannel(CHANNEL)),
        ),
      ),
    );
  }

  private isDirectoryUri(uri: vscode.Uri): Effect.Effect<boolean> {
    return Effect.tryPromise({
      try: () => vscode.workspace.fs.stat(uri),
      catch: (error) => error,
    }).pipe(
      Effect.map((stat) => (stat.type & vscode.FileType.Directory) !== 0),
      Effect.orElseSucceed(() => false),
    );
  }

  private realDirectoryPath(uri: vscode.Uri): Effect.Effect<string> {
    return Effect.tryPromise({
      try: () => fs.realpath(uri.fsPath),
      catch: (error) => error,
    }).pipe(Effect.orElseSucceed(() => this.normalizeFsPath(uri.fsPath)));
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
