import { join } from 'node:path';

import { Cause, Effect, Exit } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { formatError } from '@common/errors';
import { storeCredential } from '@common/secrets/storeCredential';
import {
  settingsViewProgram,
  type SettingsViewInboundHandlerRegistry,
} from '@controllers/settingsView/settingsViewDispatch';
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import {
  listGitHubSubscriptionEntries,
  noActiveGitHubSubscriptionMessage,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import {
  NotificationFailed,
  PromptFailed,
  type MessageHost,
} from '@hosts/uiHosts';
import { apiProviderOfSecretName } from '@model/apiProviders';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { StorageFs, withSessionFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { codingPlanForUsageSetting } from '@shared/codingPlanSubscriptions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { type RunId } from '@shared/schemas';
import {
  SettingsViewInboundMessageSchema,
  type DerivedSettingsSnapshot,
} from '@shared/settingsView/settingsViewMessages';
import {
  applyStateSettingUpdate,
  type SettingsSnapshotPosters,
} from '@shared/settingsView/handlers/stateSettingWrite';
import {
  unsupported,
  unsupportedCommands,
  UnsupportedCommandError,
} from '@shared/utils/dispatcher';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { goalList } from '@tools/goal';
import { refreshToolAvailability } from '@tools/toolAvailability';
import {
  GITHUB_TOKEN_CREATE_URL,
  GITHUB_TOKEN_PROMPT,
  GITHUB_TOKEN_REMOVED_MESSAGE,
  GITHUB_TOKEN_SAVED_MESSAGE,
  GITHUB_TOKEN_STORAGE_KEY,
  gitHubTokenRejectedMessage,
  resolveGitHubTokenSource,
} from '@tools/github/githubAuth';
import { ensureError } from '@utils/errors/errorMessage';
import { subscribeDesktopAppSignal } from './desktopAppSignalSubscription.js';
import { subscribeDesktopGoalChanges } from './desktopGoalSubscription.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import type { DesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import type { DesktopToolingSettingsController } from './desktopToolingSettingsController.js';

export interface DesktopSettingsUiHost extends Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
> {
  openPath(filePath: string): Effect.Effect<void, Error>;
  /**
   * Select the run as the window's active run. `'unavailable'` covers a
   * presentation that could not be reached at all; the reveal is then reported
   * through {@link DesktopSettingsUiHost.onError} rather than here.
   */
  /** Select a run in the shown paper's surface: `missing` when the view
   *  no longer holds it, `unavailable` when no paper is shown. */
  revealRun(runId: RunId): Promise<'revealed' | 'missing' | 'unavailable'>;
  /**
   * Display label for a run, used by the Git tab to name each subscription's
   * owning agent run. Returns undefined when no presentation is attached, in
   * which case the raw run id is shown.
   */
  getRunLabel(runId: RunId): string | undefined;
  /** Prompt for a secret (masked). Used for the GitHub personal access token. */
  promptForSecret(input: {
    title: string;
    prompt: string;
  }): Effect.Effect<string | undefined>;
  openExternal(url: string): Promise<void>;
  confirmAction(message: string, confirmLabel?: string): Promise<boolean>;
  onError(error: unknown): void;
}

export interface DesktopSettingsIpcOptions {
  postToRenderer(message: unknown): void;
  agentSettingsController: DesktopAgentSettingsController;
  credentialSettingsController: DesktopCredentialSettingsController;
  toolingSettingsController: DesktopToolingSettingsController;
  /** Main-process global store, threaded in by the caller (see mainViewIpc). */
  globalState: StateStore;
  /**
   * Main-process secret store, threaded in by the caller. Backs the Git tab's
   * personal access token: read for its status, written when set, deleted when
   * removed.
   */
  secrets: PlatformSecrets;
  ui: DesktopSettingsUiHost;
  /**
   * The session of the paper this settings surface serves. Its roots supply
   * the paper's workspace state and config; goal mutations are emitted on it,
   * so the Goals tab follows a run without a manual refresh, and app-signal
   * listeners re-read the paper's state inside its scope. The desktop has no
   * process-default session, so it must be passed.
   */
  session: SessionHandle;
  /** The process runtime this window was handed; every Effect below runs on
   *  it. */
  runtime: ProcessRuntime;
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(options?: {
    deferAgentCatalogRefresh?: boolean;
  }): Effect.Effect<void, Error, ProcessServices>;
  signInChatGpt(): Effect.Effect<void, Error, ProcessServices>;
  /**
   * Releases the goal and app-signal subscriptions. They are scoped to the
   * window that built this IPC, not to the process: `createWindow` runs again
   * on macOS dock reactivation, so an undisposed listener would post to a
   * destroyed window's renderer — and, for `githubTokenInvalid`, raise a
   * dialog against a `BrowserWindow` that no longer exists.
   */
  dispose(): void;
}

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const { globalState, runtime } = options;
  const { roots } = options.session;
  const { workspaceState, config } = roots;
  // The memory controller's prompts are the window's own dialogs; a window
  // that has gone away rejects them, and that reaches the controller as a typed
  // failure rather than as an unknown rejection — `PromptFailed` for the
  // confirmation, and the notification member's own tag for the warning it is.
  const memoryController = new SettingsMemoryController({
    prompt: {
      confirm: (message, promptOptions) =>
        Effect.tryPromise({
          try: async () =>
            options.ui.confirmAction(message, promptOptions?.confirmLabel),
          catch: (cause) =>
            new PromptFailed({
              reason: 'host-unavailable',
              member: 'confirm',
              message: 'The desktop window would not show the confirmation.',
              cause,
            }),
        }),
      warning: (message) =>
        options.ui.showInfoMessage(message).pipe(Effect.map(() => undefined)),
    },
  });
  const modelSelectionController =
    options.credentialSettingsController.modelSelectionController;

  function postModelSelectionData() {
    return Effect.map(
      modelSelectionController.buildModelSelectionMessage(),
      (message) => {
        options.postToRenderer(message);
      },
    );
  }

  function postMemoryData() {
    return Effect.map(memoryController.getMemoryDataMessage(), (message) => {
      options.postToRenderer(message);
    });
  }

  /**
   * Post one memory message, skipping a mutation the user declined (a
   * cancelled delete, a pin over the cap) — the controller answers those with
   * `null` after prompting.
   */
  function postMemoryMutation(
    mutation: Effect.Effect<unknown, never, StorageFs>,
  ) {
    return Effect.map(mutation, (message) => {
      if (message != null) options.postToRenderer(message);
    });
  }

  /**
   * Post one memory preview, or the preview's error placeholder when it
   * cannot be produced, so the view never waits on a preview that will not
   * arrive.
   */
  function postMemoryPreview(storagePath: string) {
    return Effect.map(
      Effect.exit(memoryController.getMemoryPreviewMessage(storagePath)),
      (previewed) => {
        if (Exit.isSuccess(previewed)) {
          options.postToRenderer(previewed.value);
          return;
        }
        // A disposed runtime interrupts this read; the view it would repaint
        // is going away with it, so there is no placeholder to post.
        if (Cause.hasInterrupts(previewed.cause)) return;
        options.ui.onError(Cause.squash(previewed.cause));
        options.postToRenderer(
          memoryController.getMemoryPreviewErrorMessage(storagePath),
        );
      },
    );
  }

  const settingsStores: SettingsStores = {
    config,
    workspaceState,
    globalState,
  };

  /** Post one catalog-derived snapshot. */
  function postSettingsSnapshot(snapshot: DerivedSettingsSnapshot) {
    return Effect.map(
      buildSettingsSnapshotMessage(snapshot, settingsStores, 'desktop'),
      (message) => options.postToRenderer(message),
    );
  }

  function postSkillsList() {
    return Effect.map(
      loadRuntimeSkillDisplay(roots.workspace, roots),
      (result) => {
        options.postToRenderer({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST,
          ...result,
        });
      },
    );
  }

  // Memory lives under this project's storage root: the paths the OS opens are
  // joined onto that root as data, and the folder is created through the
  // session's storage view.
  function openMemoryFile(input: { storagePath: string }) {
    return Effect.gen(function* () {
      const resolvedPath = resolveMemoryStoragePath(input.storagePath);
      yield* options.ui.openPath(join(roots.storage, resolvedPath));
    });
  }

  function openMemoryFolder() {
    return Effect.gen(function* () {
      const memoryPath = resolveMemoryStoragePath();
      yield* StorageFs.use((storage) =>
        storage.makeDirectory(memoryPath, { recursive: true }),
      );
      yield* options.ui.openPath(join(roots.storage, memoryPath));
    });
  }

  function postGoalList() {
    return Effect.gen(function* () {
      // The list is read from memory and the view repainted before this
      // program suspends, as the synchronous `try` it replaces was.
      const listed = yield* Effect.exit(
        Effect.try({
          try: () => goalList(options.session),
          catch: (cause) => cause,
        }),
      );
      if (Exit.isSuccess(listed)) {
        options.postToRenderer({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
          items: listed.value,
        });
        return;
      }
      if (Cause.hasInterrupts(listed.cause)) return;
      const error = Cause.squash(listed.cause);
      options.ui.onError(error);
      yield* options.ui.showErrorMessage(
        formatError('Failed to load goals', error),
      );
    });
  }

  function postInitialSettingsData() {
    return Effect.gen(function* () {
      yield* postSettingsSnapshot('git-author');
      yield* options.toolingSettingsController.postLatexConfigValues();
      // Forked, not yielded: `runFork` runs the goal read on this turn, so the
      // list still repaints ahead of the snapshots below, and the dialog a
      // failed read raises does not hold them up. Nothing waits on it, as
      // nothing waited on the eagerly started promise it replaces.
      runAsync(postGoalList());
      yield* postSettingsSnapshot('multi-agent');
      yield* postSettingsSnapshot('approval');
      yield* postSettingsSnapshot('skills');
      yield* postSettingsSnapshot('telemetry');
      yield* postSettingsSnapshot('memory');
      yield* Effect.all(
        [
          postSkillsList(),
          postMemoryData(),
          postModelSelectionData(),
          postGitHubTokenStatus(),
          postGitHubSubscriptions(),
          options.credentialSettingsController.postStartupData(),
          options.toolingSettingsController.postStartupData(),
          options.agentSettingsController.postStartupData(),
        ],
        { concurrency: 'unbounded', discard: true },
      );
    });
  }

  function updateModelEnabled(input: { modelName: string; enabled: boolean }) {
    return Effect.gen(function* () {
      yield* modelSelectionController.setModelEnabled(input);
      yield* postModelSelectionData();
      // The options cache is invalidated by the writer itself.
      yield* options.credentialSettingsController.refreshModelOptions();
    });
  }

  function refreshAuthDependentData(
    refreshOptions: { deferAgentCatalogRefresh?: boolean } = {},
  ): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen(function* () {
      yield* options.credentialSettingsController.refreshAuthDependentData();
      if (refreshOptions.deferAgentCatalogRefresh) return;
      yield* options.agentSettingsController.refreshCatalogData();
    });
  }

  const stateSettingSnapshotPosters: SettingsSnapshotPosters<
    Effect.Effect<void, Error, ProcessServices>
  > = {
    approval: () => postSettingsSnapshot('approval'),
    'git-author': () => postSettingsSnapshot('git-author'),
    latex: () => options.toolingSettingsController.postLatexConfigValues(),
    memory: () => postSettingsSnapshot('memory'),
    models: () => postModelSelectionData(),
    'multi-agent': () => postSettingsSnapshot('multi-agent'),
    profile: () => options.credentialSettingsController.postProfileData(),
    skills: () =>
      Effect.andThen(postSettingsSnapshot('skills'), postSkillsList()),
    telemetry: () => postSettingsSnapshot('telemetry'),
  };

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  function updateStateSetting(key: string, value: unknown) {
    return Effect.gen(function* () {
      const result = yield* applyStateSettingUpdate(key, value, {
        host: 'desktop',
        stores: settingsStores,
        onApprovalPolicyChanged: (policy) =>
          options.session.setApprovalPolicy(policy),
      });
      if (result.kind === 'ignored') return;
      if (result.kind === 'rejected' || result.kind === 'failed') {
        options.ui.onError(result.error);
        const label = result.entry.title ?? result.entry.key;
        const prefix =
          result.kind === 'rejected' ? 'Invalid value for' : 'Failed to update';
        yield* options.ui.showErrorMessage(
          formatError(`${prefix} "${label}"`, result.error),
        );
      }
      yield* stateSettingSnapshotPosters[result.entry.surfaces.settingsView]();
      if (result.kind !== 'applied') return;
      const invalidatesModelOptions =
        result.entry.onWrite?.invalidatesModelOptions === true;
      if (invalidatesModelOptions) {
        yield* options.credentialSettingsController.refreshAfterProviderSettingChange(
          key,
        );
      } else if (codingPlanForUsageSetting(key) !== undefined) {
        yield* options.credentialSettingsController.postSubscriptionUsage();
      }
    });
  }

  /**
   * The window's own fork point for work nobody awaits: a settled cause is
   * reported through `onError`, exactly as the rejection of the promise this
   * replaces was.
   */
  function runAsync<E>(
    work: Effect.Effect<void, E, StorageFs | ProcessServices>,
  ): void {
    runtime.runFork(
      withSessionFs(roots, work).pipe(
        Effect.catchCause(
          (cause): Effect.Effect<void, E | NotificationFailed> => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const error = Cause.squash(cause);
            return error instanceof UnsupportedCommandError
              ? options.ui.showInfoMessage(error.reason)
              : Effect.failCause(cause);
          },
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;
          const error = Cause.squash(cause);
          return Effect.sync(() =>
            options.ui.onError(
              error instanceof NotificationFailed ? error.cause : error,
            ),
          );
        }),
      ),
    );
  }

  // Agent runs execute in this same main process and the settings panel shares
  // the app window with run progress, so a Goals tab left open during a run
  // needs the push. The session outlives the window, so the subscription is
  // window-scoped and released in `dispose` below.
  //
  // App signals and goal changes deliver on their own fiber of this window's
  // runtime, not on the emitter's stack. Every refresh a signal triggers reads
  // this paper's own session, which these posters take from `options.session`.
  const subscriptions = [
    subscribeDesktopGoalChanges(
      options.session,
      () => runAsync(postGoalList()),
      runtime,
    ),
  ];

  // ── GitHub token + PR/repo/issue subscriptions (Git tab) ──

  function postGitHubTokenStatus() {
    return Effect.map(resolveGitHubTokenSource(options.secrets), (status) => {
      options.postToRenderer({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
        status,
      });
    });
  }

  function setGitHubToken() {
    return Effect.gen(function* () {
      const token = yield* options.ui.promptForSecret({
        title: 'GitHub token',
        prompt: GITHUB_TOKEN_PROMPT,
      });
      if (token == null) return;
      yield* storeCredential(options.secrets, {
        secretName: GITHUB_TOKEN_STORAGE_KEY,
        value: token,
        kind: 'github',
      });
      yield* options.ui.showInfoMessage(GITHUB_TOKEN_SAVED_MESSAGE);
      yield* postGitHubTokenStatus();
    });
  }

  function removeGitHubToken() {
    return Effect.gen(function* () {
      yield* options.secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
      yield* options.ui.showInfoMessage(GITHUB_TOKEN_REMOVED_MESSAGE);
      yield* postGitHubTokenStatus();
    });
  }

  // Reads the process's subscription registries and repaints.
  const postGitHubSubscriptions = Effect.fn('desktop.postSubscriptions')(
    function* () {
      options.postToRenderer({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
        subscriptions: yield* listGitHubSubscriptionEntries((runId) =>
          options.ui.getRunLabel(runId),
        ),
      });
    },
  );

  // The same stance as the goal subscription above: a run that binds or
  // releases a PR, repo or issue subscription changes the list the Git tab is
  // showing, which the desktop used to re-read only when the user asked.
  subscriptions.push(
    subscribeDesktopAppSignal(runtime, 'githubSubscriptionsChanged', () =>
      runAsync(postGitHubSubscriptions()),
    ),
    // `apply_team` writes the roster straight from the setup agent, so the
    // open view is showing agents and a team it just replaced. The signal
    // comes from whichever paper's run applied the team; the catalog is
    // rebuilt from this paper's presets, not the emitter's.
    subscribeDesktopAppSignal(runtime, 'agentRosterChanged', () =>
      runAsync(options.agentSettingsController.refreshCatalogData()),
    ),
    // Outside VS Code a rejected token left the pollers failing in silence.
    // The dialog is the whole fix: `resolveGitHubTokenSource` reports only
    // which store holds a token, and rejection leaves the secret in place, so
    // re-posting the status would repaint the same "token set" badge. Marking
    // a stored token as rejected would need a new status on the wire.
    subscribeDesktopAppSignal(runtime, 'githubTokenInvalid', ({ message }) =>
      runAsync(
        options.ui.showErrorMessage(gitHubTokenRejectedMessage(message)),
      ),
    ),
    // The secret store announces every committed write, whoever wrote it: the
    // settings round-trip, the setup agent's `unset_api_key`, another window.
    // A provider key repaints this window's credential surfaces; the GitHub
    // token gates the `github_subscription` tool group, so it re-probes, and
    // `toolAvailabilityChanged` repaints the Tools tab. Other entries (OAuth
    // tokens, sign-in nonces) are ignored.
    subscribeDesktopAppSignal(runtime, 'credentialChanged', ({ key }) => {
      const provider = apiProviderOfSecretName(key);
      if (provider !== undefined) {
        runAsync(
          options.credentialSettingsController.refreshAfterProviderKeyChange(
            provider,
          ),
        );
      } else if (key === GITHUB_TOKEN_STORAGE_KEY) {
        runAsync(
          refreshToolAvailability({
            workspaceRoot: roots.workspace,
            config: roots.config,
          }),
        );
      }
    }),
  );

  /**
   * Jump from a settings entry (a goal, a PR subscription) to the run that owns
   * it. A run deleted since the entry was written has nothing to show, so
   * say so instead of leaving the click with no visible effect.
   */
  function revealRun(runId: RunId) {
    return Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () => options.ui.revealRun(runId),
        catch: ensureError,
      });
      if (result === 'missing') {
        yield* options.ui.showInfoMessage(
          'The agent run is no longer available.',
        );
      }
    });
  }

  function unsubscribeGitHub(data: { key: string }) {
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const removed = yield* unsubscribeGitHubKey(data.key);
        const absent = noActiveGitHubSubscriptionMessage(data.key);
        yield* removed === 0
          ? options.ui.showInfoMessage(absent)
          : postGitHubSubscriptions();
      });
    });
  }

  const settingsHandlers: SettingsViewInboundHandlerRegistry<
    ProcessServices | StorageFs
  > = {
    // The settings webview announcing itself: answer with the capabilities
    // this host's registry declares unsupported, then its opening data. The
    // other views share the command and want neither.
    webviewReady: (message) =>
      Effect.gen(function* () {
        if (message.view !== 'settings') return;
        options.postToRenderer({
          command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
          commands: unsupportedCommands(settingsHandlers),
        });
        yield* postInitialSettingsData();
      }),
    getMemoryData: () => postMemoryData(),
    getMemoryPreview: (message) => postMemoryPreview(message.storagePath),
    openMemoryFile,
    openMemoryFolder,
    deleteMemory: (message) =>
      postMemoryMutation(memoryController.deleteMemory(message)),
    pinMemory: (message) =>
      postMemoryMutation(
        memoryController.setMemoryPinned(message.storagePath, true),
      ),
    unpinMemory: (message) =>
      postMemoryMutation(
        memoryController.setMemoryPinned(message.storagePath, false),
      ),
    ...options.credentialSettingsController.profileHandlers,
    setModelEnabled: (message) => updateModelEnabled(message),
    setModelReasoningLevel: (message) =>
      Effect.andThen(
        modelSelectionController.setReasoningLevel(message),
        postModelSelectionData(),
      ),
    requestModelAccess: unsupported('Copilot models require VS Code.'),
    clearCopilotRoute: unsupported('Copilot models require VS Code.'),
    ...options.agentSettingsController.handlers,
    // Mirrors the extension's `GitHubSubscriptionHandlers`. The token store and
    // the subscription registry are host-agnostic (`@tools/github`); only the
    // secret prompt, the browser hand-off, and the run reveal differ here.
    getGitHubTokenStatus: () => postGitHubTokenStatus(),
    setGitHubToken: () => setGitHubToken(),
    removeGitHubToken: () => removeGitHubToken(),
    openGitHubTokenUrl: () =>
      Effect.tryPromise({
        try: () => options.ui.openExternal(GITHUB_TOKEN_CREATE_URL),
        catch: ensureError,
      }),
    getPRSubscriptions: () => postGitHubSubscriptions(),
    unsubscribePR: unsubscribeGitHub,
    openPRSubscriptionStream: (message) => revealRun(message.runId),
    ...options.credentialSettingsController.chatGptHandlers,
    ...options.credentialSettingsController.grokHandlers,
    getSubscriptionUsage: (message) =>
      options.credentialSettingsController.postSubscriptionUsage(
        message.forceRefresh ?? false,
      ),
    updateStateSetting: (message) =>
      updateStateSetting(message.key, message.value),
    ...options.toolingSettingsController.toolHandlers,
    ...options.toolingSettingsController.latexHandlers,
    // Inline criticism renders `\criticize{...}` annotations as editor
    // squiggles and Problems-panel entries. Both are VS Code editor surfaces
    // with no desktop counterpart, so this stays host-specific rather than
    // "not yet ported".
    getInlineCriticismEnabled: unsupported(
      'Inline criticism needs the VS Code editor and Problems panel.',
    ),
    setInlineCriticismEnabled: unsupported(
      'Inline criticism needs the VS Code editor and Problems panel.',
    ),
    getGoalList: () => postGoalList(),
    revealGoalRun: (message) => revealRun(message.runId),
  };

  return {
    refreshAuthDependentData,
    signInChatGpt: () => options.credentialSettingsController.signInChatGpt(),

    dispose() {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    },

    handleMessage(message: DesktopCommandMessage) {
      const parsed = SettingsViewInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      runAsync(
        settingsViewProgram(parsed.data, settingsHandlers).pipe(Effect.asVoid),
      );
      return true;
    },
  };
}
