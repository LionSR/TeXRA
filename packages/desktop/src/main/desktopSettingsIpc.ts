import { runInSession, type SessionHandle } from '@agent/runtime';
import { formatError } from '@common/errors';
import { storeCredential } from '@common/secrets/storeCredential';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import {
  listGitHubSubscriptionEntries,
  noActiveGitHubSubscriptionMessage,
  unsubscribeGitHubKey,
} from '@controllers/settingsView/githubSubscriptions';
import { appSignals } from '@eventBus/AppSignals';
import type { MessageHost } from '@hosts/uiHosts';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { codingPlanForUsageSetting } from '@shared/codingPlanSubscriptions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type DerivedSettingsSnapshot,
  type SettingsViewInboundHandlerRegistry,
} from '@shared/schemas';
import {
  applyStateSettingUpdate,
  type SettingsSnapshotPosters,
} from '@shared/settingsView/handlers/stateSettingWrite';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';
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
import { StorageFS } from '@utils/files/storageFS';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import type { DesktopStreamRevealResult } from './desktopAgentExecution.js';
import type { DesktopAgentSettingsController } from './desktopAgentSettingsController.js';
import type { DesktopCredentialSettingsController } from './desktopCredentialSettingsController.js';
import type { DesktopToolingSettingsController } from './desktopToolingSettingsController.js';

export interface DesktopSettingsUiHost extends Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
> {
  openPath(filePath: string): Promise<void>;
  /**
   * Select the stream as the window's active stream. `'unavailable'` covers a
   * presentation that could not be reached at all; the reveal is then reported
   * through {@link DesktopSettingsUiHost.onError} rather than here.
   */
  revealStream(
    streamId: string,
  ): Promise<DesktopStreamRevealResult | 'unavailable'>;
  /**
   * Display label for a stream, used by the Git tab to name each subscription's
   * owning agent run. Returns undefined when no presentation is attached, in
   * which case the raw stream id is shown.
   */
  getStreamLabel(streamId: string): string | undefined;
  /** Prompt for a secret (masked). Used for the GitHub personal access token. */
  promptForSecret(input: {
    title: string;
    prompt: string;
  }): Promise<string | undefined>;
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
  ui: DesktopSettingsUiHost;
  /**
   * The session of the paper this settings surface serves. Its roots supply
   * the paper's workspace state and config; goal mutations are emitted on it,
   * so the Goals tab follows a run without a manual refresh, and app-signal
   * listeners re-read the paper's state inside its scope. The desktop has no
   * process-default session, so it must be passed.
   */
  session: SessionHandle;
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(options?: {
    deferAgentCatalogRefresh?: boolean;
  }): Promise<void>;
  signInChatGpt(): Promise<void>;
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
  const { globalState } = options;
  const { workspaceState, config } = options.session.roots;
  // Commands declared `unsupported(...)` in settingsHandlers below surface as
  // a visible info dialog instead of a console-only error log.
  const onError = createDesktopErrorReporter(options.ui.onError, (error) => {
    void Promise.resolve(options.ui.showInfoMessage(error.reason)).catch(
      options.ui.onError,
    );
  });
  const settingsHost = new SettingsViewHost({
    state: { workspaceState, globalState },
    respond: options.postToRenderer,
    controllers: {
      modelSelection:
        options.credentialSettingsController.modelSelectionController,
    },
    memoryPrompt: {
      confirm: (message, promptOptions) =>
        options.ui.confirmAction(message, promptOptions?.confirmLabel),
      warning: async (message) => {
        await options.ui.showInfoMessage(message);
      },
    },
  });

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

  async function postSkillsList(): Promise<void> {
    const result = await loadRuntimeSkillDisplay();
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST,
      ...result,
    });
  }

  async function openMemoryFile(input: { storagePath: string }): Promise<void> {
    const resolvedPath = resolveMemoryStoragePath(input.storagePath);
    await options.ui.openPath(StorageFS.fullPath(resolvedPath));
  }

  async function openMemoryFolder(): Promise<void> {
    const memoryPath = resolveMemoryStoragePath();
    await StorageFS.ensureDir(memoryPath);
    await options.ui.openPath(StorageFS.fullPath(memoryPath));
  }

  async function postGoalList(): Promise<void> {
    try {
      options.postToRenderer({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        items: GoalStore.list(),
      });
    } catch (error) {
      options.ui.onError(error);
      await options.ui.showErrorMessage(
        formatError('Failed to load goals', error),
      );
    }
  }

  async function postInitialSettingsData(): Promise<void> {
    // Model availability can change without a session event (a server-side
    // tier or subscription flip), so the panel must not paint a stale list.
    invalidateModelOptionsCache();
    postSettingsSnapshot('git-author');
    options.toolingSettingsController.postLatexConfigValues();
    const goalListPosted = postGoalList();
    const modelSelectionDataPosted = settingsHost.sendModelSelectionData();
    postSettingsSnapshot('multi-agent');
    postSettingsSnapshot('approval');
    postSettingsSnapshot('skills');
    postSettingsSnapshot('telemetry');
    postSettingsSnapshot('memory');
    await Promise.all([
      goalListPosted,
      postSkillsList(),
      settingsHost.sendMemoryData(),
      modelSelectionDataPosted,
      postGitHubTokenStatus(),
      postGitHubSubscriptions(),
      options.credentialSettingsController.postStartupData(),
      options.toolingSettingsController.postStartupData(),
      options.agentSettingsController.postStartupData(),
    ]);
  }

  async function updateModelEnabled(input: {
    modelName: string;
    enabled: boolean;
  }): Promise<void> {
    await settingsHost.setModelEnabled(input, {
      // The options cache is invalidated by the writer itself.
      afterPost: () =>
        options.credentialSettingsController.postMainModelOptionsData(),
    });
  }

  async function refreshAuthDependentData(
    refreshOptions: { deferAgentCatalogRefresh?: boolean } = {},
  ): Promise<void> {
    await options.credentialSettingsController.refreshAuthDependentData();
    if (refreshOptions.deferAgentCatalogRefresh) return;
    await options.agentSettingsController.refreshCatalogData();
  }

  const stateSettingSnapshotPosters: SettingsSnapshotPosters = {
    approval: () => postSettingsSnapshot('approval'),
    'git-author': () => postSettingsSnapshot('git-author'),
    latex: () => options.toolingSettingsController.postLatexConfigValues(),
    memory: () => postSettingsSnapshot('memory'),
    models: () => settingsHost.sendModelSelectionData(),
    'multi-agent': () => postSettingsSnapshot('multi-agent'),
    profile: () => options.credentialSettingsController.postProfileData(),
    skills: async () => {
      postSettingsSnapshot('skills');
      await postSkillsList();
    },
    telemetry: () => postSettingsSnapshot('telemetry'),
  };

  /**
   * Generic write path for catalog-backed settings-view rows.
   */
  async function updateStateSetting(
    key: string,
    value: unknown,
  ): Promise<void> {
    const result = await applyStateSettingUpdate(key, value, {
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
      await options.ui.showErrorMessage(
        formatError(`${prefix} "${label}"`, result.error),
      );
    }
    await stateSettingSnapshotPosters[result.entry.surfaces.settingsView]();
    if (result.kind !== 'applied') return;
    const invalidatesModelOptions =
      result.entry.onWrite?.invalidatesModelOptions === true;
    if (invalidatesModelOptions) {
      invalidateModelOptionsCache();
      await options.credentialSettingsController.refreshAfterProviderSettingChange(
        key,
      );
    }
    if (
      !invalidatesModelOptions &&
      codingPlanForUsageSetting(key) !== undefined
    ) {
      await options.credentialSettingsController.postSubscriptionUsage();
    }
  }

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  /**
   * App signals run their listeners on the emitter's call stack, so a listener
   * fired from a run in another paper would otherwise resolve `workspaceRoots()`
   * to that paper. Every refresh a signal triggers runs in this paper's session.
   */
  function runAsyncInPaper(work: () => Promise<void>): void {
    runAsync(Promise.resolve(runInSession(options.session, work)));
  }

  // Agent runs execute in this same main process and the settings panel shares
  // the app window with run progress, so a Goals tab left open during a run
  // needs the push. The session outlives the window, so the subscription is
  // window-scoped and released in `dispose` below.
  const subscriptions = [
    subscribeGoalStateChanges(options.session, () => runAsync(postGoalList())),
  ];

  // ── GitHub token + PR/repo/issue subscriptions (Git tab) ──

  async function postGitHubTokenStatus(): Promise<void> {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status: await resolveGitHubTokenSource(platform().secrets),
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
  async function setGitHubToken(): Promise<void> {
    const token = await options.ui.promptForSecret({
      title: 'GitHub token',
      prompt: GITHUB_TOKEN_PROMPT,
    });
    if (token == null) return;
    await storeCredential(platform().secrets, {
      secretName: GITHUB_TOKEN_STORAGE_KEY,
      value: token,
      kind: 'github',
    });
    await options.ui.showInfoMessage(GITHUB_TOKEN_SAVED_MESSAGE);
    await postGitHubTokenStatus();
    await refreshToolAvailability();
  }

  async function removeGitHubToken(): Promise<void> {
    await platform().secrets.delete(GITHUB_TOKEN_STORAGE_KEY);
    await options.ui.showInfoMessage(GITHUB_TOKEN_REMOVED_MESSAGE);
    await postGitHubTokenStatus();
    await refreshToolAvailability();
  }

  async function postGitHubSubscriptions(): Promise<void> {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: listGitHubSubscriptionEntries((streamId) =>
        options.ui.getStreamLabel(streamId),
      ),
    });
  }

  // The same stance as the goal subscription above: a run that binds or
  // releases a PR, repo, or issue subscription changes the list the Git tab is
  // showing, and until now the desktop only re-read it when the user asked.
  subscriptions.push(
    appSignals.on('githubSubscriptionsChanged', () =>
      runAsyncInPaper(postGitHubSubscriptions),
    ),
    // `apply_team` writes the roster straight from the setup agent, so the
    // open view is showing agents and a team it just replaced. The signal
    // comes from whichever paper's run applied the team; the catalog is
    // rebuilt from this paper's presets, not the emitter's.
    appSignals.on('agentRosterChanged', () =>
      runAsyncInPaper(() =>
        options.agentSettingsController.refreshCatalogData(),
      ),
    ),
    // Outside VS Code a rejected token left the pollers failing in silence.
    // The dialog is the whole fix: `resolveGitHubTokenSource` reports only
    // which store holds a token, and rejection leaves the secret in place, so
    // re-posting the token status would repaint the same "token set" badge.
    // Marking a stored token as rejected would need a new status on the wire.
    appSignals.on('githubTokenInvalid', ({ message }) =>
      runAsync(
        Promise.resolve(
          options.ui.showErrorMessage(gitHubTokenRejectedMessage(message)),
        ),
      ),
    ),
  );

  /**
   * Jump from a settings entry (a goal, a PR subscription) to the run that owns
   * it. A stream deleted since the entry was written has nothing to show, so
   * say so instead of leaving the click with no visible effect.
   */
  async function revealStream(streamId: string): Promise<void> {
    const result = await options.ui.revealStream(streamId);
    if (result === 'missing') {
      await options.ui.showInfoMessage(
        'The agent stream is no longer available.',
      );
    }
  }

  async function unsubscribeGitHub(data: { key: string }): Promise<void> {
    const removed = unsubscribeGitHubKey(data.key);
    if (removed === 0) {
      await options.ui.showInfoMessage(
        noActiveGitHubSubscriptionMessage(data.key),
      );
      return;
    }
    await postGitHubSubscriptions();
  }

  const settingsHandlers: SettingsViewInboundHandlerRegistry = {
    // WEBVIEW_READY is intercepted in handleMessage below, before reaching
    // the dispatcher, so this entry is never actually invoked — it exists
    // only to satisfy the exhaustive registry type.
    webviewReady: () => {},
    getMemoryData: () => settingsHost.sendMemoryData(),
    getMemoryPreview: (message) =>
      settingsHost.sendMemoryPreview(message, { onError }),
    openMemoryFile,
    openMemoryFolder,
    deleteMemory: (message) => settingsHost.deleteMemory(message),
    pinMemory: (message) =>
      settingsHost.setMemoryPinned(message.storagePath, true),
    unpinMemory: (message) =>
      settingsHost.setMemoryPinned(message.storagePath, false),
    ...options.credentialSettingsController.profileHandlers,
    setModelEnabled: updateModelEnabled,
    setModelReasoningLevel: (message) =>
      settingsHost.setReasoningLevel(message),
    requestModelAccess: unsupported('Copilot models require VS Code.'),
    clearCopilotRoute: unsupported('Copilot models require VS Code.'),
    ...options.agentSettingsController.handlers,
    // Mirrors the extension's `GitHubSubscriptionHandlers`. The token store and
    // the subscription registry are host-agnostic (`@tools/github`); only the
    // secret prompt, the browser hand-off, and the stream reveal differ here.
    getGitHubTokenStatus: postGitHubTokenStatus,
    setGitHubToken,
    removeGitHubToken,
    openGitHubTokenUrl: async () => {
      await options.ui.openExternal(GITHUB_TOKEN_CREATE_URL);
    },
    getPRSubscriptions: postGitHubSubscriptions,
    unsubscribePR: unsubscribeGitHub,
    openPRSubscriptionStream: (message) => revealStream(message.streamId),
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
    getGoalList: postGoalList,
    revealGoalStream: (message) => revealStream(message.streamId),
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
