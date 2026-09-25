// Third-party imports
import {
  Cause,
  Effect,
  FileSystem,
  type PlatformError,
  Schedule,
  Stream,
} from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  AgentDirectoryService,
  type AgentSource,
  agentSourceDirectory,
} from '@agent/index';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import { type OpenDialogFailed, selectFolder } from '@frontend/ui/dialogs';
import { withLogChannel } from '@logger/effectLog';
import {
  type AgentDirectoriesFailed,
  type StateWriteFailed,
  type StateStore,
} from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { AGENT_SOURCE } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'AgentLoad';

/**
 * Retry only a runtime watcher error (Node's JS recursive watcher on Linux
 * can fail mid-life, reported as `Unknown`), with bounded backoff; a missing
 * or unreadable directory fails fast. The budget resets once an event passes.
 */
const EXTERNAL_WATCH_RECOVERY =
  'agent edits there reload after the directory setting changes or the window reloads';

const EXTERNAL_WATCH_RETRY = Schedule.exponential('1 second').pipe(
  Schedule.upTo({ times: 5 }),
  Schedule.while(
    ({ input }: { readonly input: PlatformError.PlatformError }) =>
      input.reason._tag === 'Unknown',
  ),
);

/** The two host services `initialize()` hands the manager, kept together so
 *  one guard covers both. */
interface AgentDirectoryHost {
  readonly directories: AgentDirectoryService;
  readonly globalState: StateStore;
  /** The host entry's process runtime, handed down with the two services. */
  readonly runtime: ProcessRuntime;
}

class AgentDirectoryManager {
  private host: AgentDirectoryHost | undefined;
  private watcherDisposables: vscode.Disposable[] = [];
  /** The single watcher subscriber; `undefined` means nobody is listening. */
  private onAgentChange: (() => void) | undefined;
  private readonly onWatcherLane = withPerKeyLane(
    new Map<string, PerKeyLane>(),
    'agent-watcher-rebuild',
  );

  initialize(
    globalState: StateStore,
    resourcesPath: string,
    runtime: ProcessRuntime,
  ): void {
    this.host = {
      globalState,
      runtime,
      directories: new AgentDirectoryService({
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

  customConfigured(): Effect.Effect<
    boolean,
    AgentDirectoriesFailed,
    FileSystem.FileSystem
  > {
    return Effect.suspend(() => this.getHost().directories.customConfigured());
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

      yield* this.getHost().globalState.update(
        GlobalStateKey.CUSTOM_AGENT_DIR,
        selectedPath,
      );

      return selectedPath;
    });
  }

  /**
   * Watch every local agent directory and call `onChange` whenever anything
   * under one changes. One subscriber at a time — re-subscribing replaces the
   * previous callback. The subscriber debounces and rescans locally, so an
   * unfiltered event costs one glob, never a network fetch.
   */
  watchAgentDirectories(onChange: () => void): vscode.Disposable {
    const { runtime } = this.getHost();
    this.onAgentChange = onChange;
    runtime.runFork(
      this.refreshAfterDirChange().pipe(
        Effect.catch((error) =>
          Effect.logError(
            `Failed to set up agent directory watchers: ${toErrorMessage(error)}`,
          ).pipe(withLogChannel(CHANNEL)),
        ),
      ),
    );
    return {
      dispose: () => {
        this.onAgentChange = undefined;
        this.disposeAgentWatchers();
      },
    };
  }

  /**
   * Rebuild the watchers over the current directory list. Called on subscribe
   * and by the settings view after updating CUSTOM_AGENT_DIR in global state.
   * Rebuilds run one at a time on the lane, so the last one wins.
   */
  refreshAfterDirChange(): Effect.Effect<
    void,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return this.onWatcherLane(
      Effect.gen({ self: this }, function* () {
        if (!this.onAgentChange) return;
        const directories = yield* this.getHost().directories.getAllLocal();
        this.disposeAgentWatchers();
        if (!this.onAgentChange) return;
        for (const { directory, source } of directories) {
          const uri = vscode.Uri.file(directory);
          if (vscode.workspace.getWorkspaceFolder(uri)) {
            this.watchWorkspaceDirectory(uri);
          } else if (source === AGENT_SOURCE.CUSTOM) {
            // VS Code warns on a recursive watcher outside the workspace
            // (#3402), so an external custom directory takes Node's.
            yield* this.watchExternalDirectory(directory);
          }
        }
        yield* Effect.logInfo(
          `Agent directory watchers enabled: ${directories.map((d) => d.directory).join(', ')}`,
        ).pipe(withLogChannel(CHANNEL));
      }),
    );
  }

  private watchWorkspaceDirectory(directoryUri: vscode.Uri): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(directoryUri, '**/*'),
    );
    // A deleted folder reports only itself, so deletes pass unfiltered.
    const onYaml = (uri: vscode.Uri) => {
      if (uri.fsPath.endsWith('.yaml')) this.onAgentChange?.();
    };
    watcher.onDidCreate(onYaml);
    watcher.onDidChange(onYaml);
    watcher.onDidDelete(() => this.onAgentChange?.());
    this.watcherDisposables.push(watcher);
  }

  /**
   * Node's recursive watcher over an external directory, as a stream fiber
   * that lives until the watchers are disposed. A create or remove always
   * rescans (a deleted folder reports only itself); an update rescans only
   * for a `.yaml`. Interrupting the fiber closes the native watcher.
   */
  private watchExternalDirectory(
    directory: string,
  ): Effect.Effect<void, never, FileSystem.FileSystem> {
    return Effect.gen({ self: this }, function* () {
      const fs = yield* FileSystem.FileSystem;
      const fiber = yield* fs.watch(directory, { recursive: true }).pipe(
        Stream.filter(
          (event) => event._tag !== 'Update' || event.path.endsWith('.yaml'),
        ),
        // The tap sees only decisions that retry; a failure the schedule
        // gives up on logs once, in the catch below.
        Stream.retry(
          EXTERNAL_WATCH_RETRY.pipe(
            Schedule.tap(({ input }) =>
              Effect.logWarning(
                `Agent directory watcher failed for ${directory}; retrying: ${toErrorMessage(input.reason.cause ?? input)}`,
              ),
            ),
          ),
        ),
        Stream.runForEach(() => Effect.sync(() => this.onAgentChange?.())),
        // A stream that ends without an interrupt means the native watcher
        // closed itself; watching has stopped either way.
        Effect.andThen(() =>
          Effect.logWarning(
            `Stopped watching agent directory ${directory}; the native watcher closed. ${EXTERNAL_WATCH_RECOVERY}`,
          ),
        ),
        Effect.catch((error: PlatformError.PlatformError) =>
          Effect.logWarning(
            `Stopped watching agent directory ${directory}; ${EXTERNAL_WATCH_RECOVERY}: ${toErrorMessage(error.reason.cause ?? error)}`,
          ),
        ),
        // fs.watch can throw synchronously (ENOENT after a race, EMFILE,
        // ENOSPC), which surfaces as a defect; this fiber is detached, so
        // nothing else would report it.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(
                `Stopped watching agent directory ${directory}; ${EXTERNAL_WATCH_RECOVERY}: ${Cause.pretty(cause)}`,
              ),
        ),
        withLogChannel(CHANNEL),
        Effect.forkDetach,
      );
      // A VS Code disposable is synchronous and can run after deactivate
      // has disposed the process runtime, so it interrupts through the
      // fiber's own hook rather than forking onto that runtime.
      this.watcherDisposables.push({
        dispose: () => fiber.interruptUnsafe(),
      });
    });
  }

  private disposeAgentWatchers(): void {
    this.watcherDisposables.forEach((watcher) => watcher.dispose());
    this.watcherDisposables = [];
  }
}

export const agentDirectories = new AgentDirectoryManager();
