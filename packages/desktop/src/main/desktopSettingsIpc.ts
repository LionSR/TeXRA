import { join } from 'node:path';

import { Cause, Effect, Exit } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { formatError } from '@common/errors';
import { storeCredential } from '@common/secrets/storeCredential';
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import {
  listGitHubSubscriptionEntries,
  noActiveGitHubSubscriptionMessage,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import { appSignals } from '@eventBus/AppSignals';
import { PromptFailed, type MessageHost } from '@hosts/uiHosts';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import { StorageFs, withSessionFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { codingPlanForUsageSetting } from '@shared/codingPlanSubscriptions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type DerivedSettingsSnapshot,
  type RunId,
  type SettingsViewInboundHandlerRegistry,
} from '@shared/schemas';
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
  openPath(filePath: string): Effect.Effect<void, unknown>;
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
  signInChatGpt(): Effect.Effect<void, unknown, ProcessServices>;
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
  // Commands declared `unsupported(...)` in settingsHandlers below surface as
  // a visible info dialog instead of a console-only error log.
  const onError = (error: unknown): void => {
    if (!(error instanceof UnsupportedCommandError)) {
      options.ui.onError(error);
      return;
    }
    runtime.runFork(
      options.ui.showInfoMessage(error.reason).pipe(
        Effect.catchTag('NotificationFailed', (failure) =>
          Effect.sync(() => {
            options.ui.onError(failure.cause);
          }),
        ),
      ),
    );
  };
  // The memory controller's prompts are the window's own dialogs; a window
  // that has gone away rejects them, and that reaches the controller as a
  // typed failure rather than as an unknown rejection — `PromptFailed` for
  // the confirmation, and the notification member's own tag for the warning
  // it is.
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

  // Every memory program runs over this project's storage view, built from
  // the roots this window already holds.
  function postMemoryData() {
    return Effect.map(
      withSessionFs(roots, memoryController.getMemoryDataMessage()),
      (message) => {
        options.postToRenderer(message);
      },
    );
  }

  /**
   * Post one memory message, skipping a mutation the user declined (a
   * cancelled delete, a pin over the cap) — the controller answers those with
   * `null` after prompting.
   */
  function postMemoryMutation(
    mutation: Effect.Effect<unknown, never, StorageFs>,
  ) {
    return Effect.map(withSessionFs(roots, mutation), (message) => {
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
      withSessionFs(
        roots,
        Effect.exit(memoryController.getMemoryPreviewMessage(storagePath)),
      ),
      (previewed) => {
        if (Exit.isSuccess(previewed)) {
          options.postToRenderer(previewed.value);
          return;
        }
        // A disposed runtime interrupts this read; the view it would repaint
        // is going away with it, so there is no placeholder to post.
        if (Cause.hasInterrupts(previewed.cause)) return;
        onError(Cause.squash(previewed.cause));
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
  function postSettingsSnapshot(snapshot: DerivedSettingsSnapshot): void {
    options.postToRenderer(
      buildSettingsSnapshotMessage(snapshot, settingsStores, 'desktop'),
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
  async function openMemoryFile(input: { storagePath: string }): Promise<void> {
    const resolvedPath = resolveMemoryStoragePath(input.storagePath);
    await runtime.runPromise(
      options.ui.openPath(join(roots.storage, resolvedPath)),
    );
  }

  async function openMemoryFolder(): Promise<void> {
    const memoryPath = resolveMemoryStoragePath();
    await runtime.runPromise(
      withSessionFs(
        roots,
        StorageFs.use((storage) =>
          storage.makeDirectory(memoryPath, { recursive: true }),
        ),
      ),
    );
    await runtime.runPromise(
      options.ui.openPath(join(roots.storage, memoryPath)),
    );
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
      postSettingsSnapshot('git-author');
      options.toolingSettingsController.postLatexConfigValues();
      // Forked, not yielded: `runFork` runs the goal read on this turn, so
      // the list still repaints ahead of the snapshots below, and the dialog
      // a failed read raises does not hold them up. Nothing waits on it, as
      // nothing waited on the eagerly started promise it replaces.
      runAsync(postGoalList());
      postSettingsSnapshot('multi-agent');
      postSettingsSnapshot('approval');
      postSettingsSnapshot('skills');
      postSettingsSnapshot('telemetry');
      postSettingsSnapshot('memory');
      yield* Effect.all(
        [
          postSkillsList(),
          postMemoryData(),
          postModelSelectionData(),
          postGitHubTokenStatus(),
          Effect.sync(postGitHubSubscriptions),
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
    approval: () => Effect.sync(() => postSettingsSnapshot('approval')),
    'git-author': () => Effect.sync(() => postSettingsSnapshot('git-author')),
    latex: () =>
      Effect.sync(() =>
        options.toolingSettingsController.postLatexConfigValues(),
      ),
    memory: () => Effect.sync(() => postSettingsSnapshot('memory')),
    models: () => postModelSelectionData(),
    'multi-agent': () => Effect.sync(() => postSettingsSnapshot('multi-agent')),
    profile: () => options.credentialSettingsController.postProfileData(),
    skills: () =>
      Effect.andThen(
        Effect.sync(() => postSettingsSnapshot('skills')),
        postSkillsList(),
      ),
    telemetry: () => Effect.sync(() => postSettingsSnapshot('telemetry')),
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
  function runAsync<E>(work: Effect.Effect<void, E, ProcessServices>): void {
    runtime.runFork(
      work.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => onError(Cause.squash(cause))),
        ),
      ),
    );
  }

  // Agent runs execute in this same main process and the settings panel shares
  // the app window with run progress, so a Goals tab left open during a run
  // needs the push. The session outlives the window, so the subscription is
  // window-scoped and released in `dispose` below.
  //
  // App signals and goal changes run their listeners on the emitter's call
  // stack. Every refresh a signal triggers reads this paper's own session,
  // which each of these posters takes from `options.session` as data.
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

  // Both writers below re-probe external tools: the GitHub token gates the
  // `github_subscription` tool group, so without it the Tools tab keeps
  // showing the group as unavailable until the user clicks Re-check. The
  // extension gets this from `secrets.onDidChange`; the desktop has no
  // secret-change event, but these two functions are the only places it
  // writes the token, so the explicit calls cover the same ground.
  // `refreshToolAvailability` emits `toolAvailabilityChanged`, which is what
  // repaints the dashboard.
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
      yield* refreshToolAvailability({
        workspaceRoot: roots.workspace,
        config: roots.config,
      });
    });
  }

  function removeGitHubToken() {
    return Effect.gen(function* () {
      yield* options.secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
      yield* options.ui.showInfoMessage(GITHUB_TOKEN_REMOVED_MESSAGE);
      yield* postGitHubTokenStatus();
      yield* refreshToolAvailability({
        workspaceRoot: roots.workspace,
        config: roots.config,
      });
    });
  }

  // Reads the in-memory subscription registry and repaints; nothing here
  // awaits, so it stays the plain call its callers make.
  function postGitHubSubscriptions(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: listGitHubSubscriptionEntries((runId) =>
        options.ui.getRunLabel(runId),
      ),
    });
  }

  // The same stance as the goal subscription above: a run that binds or
  // releases a PR, repo, or issue subscription changes the list the Git tab is
  // showing, and until now the desktop only re-read it when the user asked.
  subscriptions.push(
    appSignals.on('githubSubscriptionsChanged', () =>
      runAsync(Effect.sync(postGitHubSubscriptions)),
    ),
    // `apply_team` writes the roster straight from the setup agent, so the
    // open view is showing agents and a team it just replaced. The signal
    // comes from whichever paper's run applied the team; the catalog is
    // rebuilt from this paper's presets, not the emitter's.
    appSignals.on('agentRosterChanged', () =>
      runAsync(options.agentSettingsController.refreshCatalogData()),
    ),
    // Outside VS Code a rejected token left the pollers failing in silence.
    // The dialog is the whole fix: `resolveGitHubTokenSource` reports only
    // which store holds a token, and rejection leaves the secret in place, so
    // re-posting the token status would repaint the same "token set" badge.
    // Marking a stored token as rejected would need a new status on the wire.
    appSignals.on('githubTokenInvalid', ({ message }) =>
      runAsync(
        options.ui.showErrorMessage(gitHubTokenRejectedMessage(message)),
      ),
    ),
  );

  /**
   * Jump from a settings entry (a goal, a PR subscription) to the run that owns
   * it. A run deleted since the entry was written has nothing to show, so
   * say so instead of leaving the click with no visible effect.
   */
  async function revealRun(runId: RunId): Promise<void> {
    const result = await options.ui.revealRun(runId);
    if (result === 'missing') {
      await runtime.runPromise(
        options.ui.showInfoMessage('The agent run is no longer available.'),
      );
    }
  }

  async function unsubscribeGitHub(data: { key: string }): Promise<void> {
    const removed = unsubscribeGitHubKey(data.key);
    if (removed === 0) {
      await runtime.runPromise(
        options.ui.showInfoMessage(noActiveGitHubSubscriptionMessage(data.key)),
      );
      return;
    }
    postGitHubSubscriptions();
  }

  const settingsHandlers: SettingsViewInboundHandlerRegistry = {
    // WEBVIEW_READY is intercepted in handleMessage below, before reaching
    // the dispatcher, so this entry is never actually invoked — it exists
    // only to satisfy the exhaustive registry type.
    webviewReady: () => {},
    getMemoryData: () => runtime.runPromise(postMemoryData()),
    getMemoryPreview: (message) =>
      runtime.runPromise(postMemoryPreview(message.storagePath)),
    openMemoryFile,
    openMemoryFolder,
    deleteMemory: (message) =>
      runtime.runPromise(
        postMemoryMutation(memoryController.deleteMemory(message)),
      ),
    pinMemory: (message) =>
      runtime.runPromise(
        postMemoryMutation(
          memoryController.setMemoryPinned(message.storagePath, true),
        ),
      ),
    unpinMemory: (message) =>
      runtime.runPromise(
        postMemoryMutation(
          memoryController.setMemoryPinned(message.storagePath, false),
        ),
      ),
    ...options.credentialSettingsController.profileHandlers,
    setModelEnabled: (message) =>
      runtime.runPromise(updateModelEnabled(message)),
    setModelReasoningLevel: (message) =>
      runtime.runPromise(
        Effect.andThen(
          modelSelectionController.setReasoningLevel(message),
          postModelSelectionData(),
        ),
      ),
    requestModelAccess: unsupported('Copilot models require VS Code.'),
    clearCopilotRoute: unsupported('Copilot models require VS Code.'),
    ...options.agentSettingsController.handlers,
    // Mirrors the extension's `GitHubSubscriptionHandlers`. The token store and
    // the subscription registry are host-agnostic (`@tools/github`); only the
    // secret prompt, the browser hand-off, and the run reveal differ here.
    getGitHubTokenStatus: () => runtime.runPromise(postGitHubTokenStatus()),
    setGitHubToken: () => runtime.runPromise(setGitHubToken()),
    removeGitHubToken: () => runtime.runPromise(removeGitHubToken()),
    openGitHubTokenUrl: async () => {
      await options.ui.openExternal(GITHUB_TOKEN_CREATE_URL);
    },
    getPRSubscriptions: postGitHubSubscriptions,
    unsubscribePR: unsubscribeGitHub,
    openPRSubscriptionStream: (message) => revealRun(message.runId),
    ...options.credentialSettingsController.chatGptHandlers,
    ...options.credentialSettingsController.grokHandlers,
    getSubscriptionUsage: (message) =>
      runtime.runPromise(
        options.credentialSettingsController.postSubscriptionUsage(
          message.forceRefresh ?? false,
        ),
      ),
    updateStateSetting: (message) =>
      runtime.runPromise(updateStateSetting(message.key, message.value)),
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
    getGoalList: () => runtime.runPromise(postGoalList()),
    revealGoalRun: (message) => revealRun(message.runId),
  };

  return {
    refreshAuthDependentData,
    signInChatGpt: () => options.credentialSettingsController.signInChatGpt(),

    dispose() {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    },

    handleMessage(message: DesktopCommandMessage) {
      // WEBVIEW_READY is a broadcast: act on it but return false so sibling
      // handlers (startup, onboarding) in the chain still receive it.
      const parsed = SettingsViewInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      if (parsed.data.command === SETTINGS_VIEW_COMMANDS.WEBVIEW_READY) {
        if (parsed.data.view === 'settings') {
          options.postToRenderer({
            command: SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS,
            commands: unsupportedCommands(settingsHandlers),
          });
          runAsync(postInitialSettingsData());
        }
        return false;
      }
      // A successful parse conclusively identifies this as a settings
      // command, so claim it (true) even when the matched entry is
      // `unsupported(...)` — the dispatcher's `false` there means "no
      // function ran," not "not mine"; onError already surfaces the
      // unsupported reason as visible feedback (see `onError` above).
      dispatchSettingsViewInbound(message, settingsHandlers, onError);
      return true;
    },
  };
}
