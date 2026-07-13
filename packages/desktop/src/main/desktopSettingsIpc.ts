import { platform, tryPlatform } from '@platform/platform';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import {
  isAllowedLatexInstallCommand,
  LatexToolingController,
} from '@controllers/settingsView/LatexToolingController';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { SettingsGoalController } from '@controllers/settingsView/SettingsGoalController';
import {
  createSettingsViewCommandHandlers,
  type SettingsViewCommandActions,
} from '@controllers/settingsView/SettingsViewCommandHandlers';
import { createSettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { applyTeamRosterWithPreflight } from '@controllers/teams/TeamRosterApplication';
import {
  computeAgentOptionsData,
  getAgentsByCategory,
  getVisibleAgents as getVisibleRegistryAgents,
  loadAgents,
  refresh,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  codexCoordinator,
  getChatGptAuthStatus,
  loginWithLoopback,
  setCodexSubscriptionToolUseOnly,
  setPreferCodexSubscription,
} from '@auth/codex';
import type { TeamAvailabilityChoice } from '@common/teams/TeamAvailabilityPreflight';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  isApiProvider,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';
import { SETTINGS_VIEW_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
} from '@shared/constants/latex';
import type { LatexConfigField } from '@shared/constants/latex';
import { AgentCategory, type AgentSource } from '@shared/schemas/agent';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type LatexSettingsStatus,
  type ReasoningLevel,
  type ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
import { unsupported, unsupportedCommands } from '@shared/utils/dispatcher';
import {
  BASH_APPROVAL_CONFIG_TARGET,
  buildApprovalSettingsMessage,
  setBashApprovalEnabled,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import { buildSuperYoloMessage } from '@shared/settingsView/handlers/superYoloHandlers';
import {
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
  buildAgentModePresetsMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import { buildChatGptAuthStatusMessage } from '@shared/settingsView/handlers/chatGptHandlers';
import { GoalStore } from '@tools/goal';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import { StorageFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  applyGitAuthorSettings,
  buildGitAuthorSettingsMessage,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import { BinaryResolver } from '@utils/system/binaryResolver';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import {
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
  setGlobalStreaming,
  setProviderEndpoint,
  setProviderStreaming,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';
import {
  type DesktopCrashReportingStatus,
  getDesktopCrashReportingStatus,
  setDesktopCrashReportingDsn,
  setDesktopCrashReportingEnabled,
} from './desktopCrashReporting.js';
import { refreshDesktopModelListStateIfNeeded } from './desktopModelListRefresh.js';
import {
  buildDefaultToolDashboardItems,
  defaultOnError,
  emptySecrets,
  findToolCommand,
  getCachedToolCheckResults,
  refreshDefaultDisabledToolCache,
} from './desktopSettingsIpcHelpers.js';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
  type DesktopMessageHandler,
} from './desktopIpcTypes.js';
import {
  DesktopHistoryHandlers,
  type DesktopHistoryOptions,
} from './desktopHistoryHandlers.js';
import type { ConfigProvider, StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';

type ToolDashboardBuilder = (
  cachedResults?: ExternalToolCheckResult[],
) => Promise<ToolDashboardItem[]>;

export interface DesktopSettingsIpcOptions extends DesktopHistoryOptions {
  postToRenderer(message: unknown): void;
  sendStartupCatalogData?: boolean;
  loadAgents?: typeof loadAgents;
  refreshAgents?: typeof refresh;
  loadAgentOptionsData?: typeof computeAgentOptionsData;
  getAgents?: (category: AgentCategory) => AgentEntry[];
  getVisibleAgents?: (category: AgentCategory) => AgentEntry[];
  globalState?: StateStore;
  workspaceState?: StateStore;
  config?: ConfigProvider;
  buildToolDashboardItems?: ToolDashboardBuilder;
  refreshToolAvailability?: () => Promise<void>;
  getCustomAgentDirectory?: () => Promise<string>;
  selectCustomAgentDirectory?: () => Promise<string | undefined>;
  openPath?: (filePath: string) => Promise<void>;
  revealPath?: (filePath: string) => Promise<void>;
  /** Route this window to the progress view and select the given stream. */
  revealStream?: (streamId: string) => Promise<void>;
  openExternalUrl?: (url: string) => Promise<void>;
  /**
   * Offer the ChatGPT sign-in URL as a copyable link. `openExternalUrl` only
   * targets the system default browser; this lets a user whose ChatGPT
   * subscription lives in a different browser open the same link there (the
   * loopback callback accepts the redirect from any browser).
   */
  presentChatGptSignInUrl?: (url: string) => void | Promise<void>;
  installToolExtension?: (extensionId: string) => Promise<void>;
  promptSecret?: (input: {
    title: string;
    prompt: string;
  }) => Promise<string | undefined>;
  promptText?: (input: {
    title: string;
    prompt: string;
  }) => Promise<string | undefined>;
  showInfoMessage?: (message: string) => Promise<void>;
  showErrorMessage?: (message: string) => Promise<void>;
  confirmAction?: (message: string, confirmLabel?: string) => Promise<boolean>;
  chooseTeamAvailability?: (input: {
    presetName: string;
    unavailableNames: readonly string[];
  }) => Promise<TeamAvailabilityChoice>;
  canAccessRemoteAgentCatalog?: () => Promise<boolean>;
  signInForRemoteAgentCatalog?: () => Promise<boolean>;
  signIn?: () => Promise<void>;
  signOut?: () => Promise<void>;
  setApiAccessMode?: (mode: 'included' | 'personal') => Promise<void>;
  initializeCrashReporting?: () => Promise<void>;
  secrets?: PlatformSecrets;
  detectLatexSettingsStatus?: () => Promise<LatexSettingsStatus>;
  runInstallCommand?: (command: string) => Promise<void>;
  runToolCommand?: (input: {
    toolId: string;
    command: string;
    kind: 'install' | 'auth';
  }) => Promise<void>;
  onError?: (error: unknown) => void;
  modelListRefresh?: PromiseLike<void>;
  /** Called after a provider API key is saved or removed. */
  onApiKeyChanged?: () => Promise<void>;
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(options?: {
    deferAgentCatalogRefresh?: boolean;
  }): Promise<void>;
  signInChatGpt(options?: { enableSubscription?: boolean }): Promise<void>;
}

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const workspaceState = options.workspaceState ?? platform().workspaceState;
  const globalState = options.globalState ?? platform().globalState;
  // Commands declared `unsupported(...)` in settingsHandlers below surface as
  // a visible info dialog instead of a console-only error log.
  const onError = createDesktopErrorReporter(
    options.onError ?? defaultOnError,
    (error) => {
      void options.showInfoMessage?.(error.reason);
    },
  );
  const historyHandlers = new DesktopHistoryHandlers({
    postToRenderer: options.postToRenderer,
    resourcesPath: options.resourcesPath,
    runExecution: options.runExecution,
    restoreTaskState: options.restoreTaskState,
    openPath: options.openPath,
    showInfoMessage: options.showInfoMessage,
    showErrorMessage: options.showErrorMessage,
    onError,
  });
  const loadAgentRegistry = options.loadAgents ?? loadAgents;
  const refreshAgentRegistry = options.refreshAgents ?? refresh;
  const loadAgentOptionsData =
    options.loadAgentOptionsData ?? computeAgentOptionsData;
  const getAgentEntries = options.getAgents ?? getAgentsByCategory;
  const getVisibleAgentEntries =
    options.getVisibleAgents ?? getVisibleRegistryAgents;
  const usesDefaultToolDashboardBuilder =
    options.buildToolDashboardItems == null;
  const buildToolDashboardItems =
    options.buildToolDashboardItems ?? buildDefaultToolDashboardItems;
  const refreshToolAvailability = options.refreshToolAvailability;
  const secrets = options.secrets ?? tryPlatform()?.secrets ?? emptySecrets;
  const getCustomAgentDirectory =
    options.getCustomAgentDirectory ??
    (() => platform().agentDirectories.custom());
  const latexConfigPersistenceController =
    new LatexConfigPersistenceController();
  const goalController = new SettingsGoalController({
    listGoals: () => GoalStore.list(),
  });
  const latexToolingController = new LatexToolingController({
    checkToolInstalled: (tool) => checkToolInstalled(tool, false),
    findPath: (tool) => BinaryResolver.findPath(tool),
    detectPackageManager,
    getPlatform: () => normalizePlatform(process.platform),
    isLatexWorkshopInstalled: () => false,
    getRecommendedStatus: () => ({
      outDir: true,
      autoRevealExclude: true,
    }),
    onDetectionError: onError,
  });
  const {
    catalog: agentCatalogController,
    directory: agentDirectoryController,
    visibility: agentVisibilityController,
  } = createSettingsAgentControllers({
    workspaceState,
    globalState,
    getCustomAgentDirectory,
    getSourceDirectory: getAgentDirectory,
    getAgents: getAgentEntries,
    getVisibleAgents: getVisibleAgentEntries,
  });
  const modelListRefresh =
    options.modelListRefresh ??
    refreshDesktopModelListStateIfNeeded({
      globalState,
      onError,
    });
  const settingsHost = createSettingsViewHost({
    state: { workspaceState, globalState },
    respond: options.postToRenderer,
    beforeModelSelectionMessage: () => modelListRefresh,
    memoryPrompt: {
      confirm: (message, promptOptions) =>
        options.confirmAction?.(message, promptOptions?.confirmLabel) ??
        Promise.resolve(true),
      warning: async (message) => {
        await options.showInfoMessage?.(message);
      },
    },
    profile: {
      globalState,
      providerIds: API_PROVIDERS,
      providerVscodeSettings: {},
      providerDisplayNames: PROVIDER_DISPLAY_NAMES,
      providerKeyUrls: PROVIDER_URLS,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(secrets, API_PROVIDERS),
      getProviderDisplayName,
      getProviderKeyUrl,
      getProviderStreaming,
      getProviderEndpoint,
      supportsCustomEndpoint,
      getConfig: (key, defaultValue) =>
        getConfigProvider().get(key, defaultValue),
      updateConfig: (key, value) =>
        getConfigProvider().update(key, value, 'global'),
      setUseIncludedModelAccess: (enabled) =>
        options.setApiAccessMode?.(enabled ? 'included' : 'personal') ??
        Promise.resolve(),
      invalidateModelOptionsCache,
    },
    profileKey: {
      prompt: {
        input: (input) =>
          options.promptSecret?.({
            title: input.title ?? input.prompt ?? 'Set API key',
            prompt: input.prompt ?? 'Enter API key',
          }) ?? Promise.resolve(undefined),
        info: async (message) => {
          await options.showInfoMessage?.(message);
          return undefined;
        },
        confirm: (message, promptOptions) =>
          options.confirmAction?.(message, promptOptions?.confirmLabel) ??
          Promise.resolve(true),
      },
      externalOpener: {
        openExternal: (url) =>
          options.openExternalUrl?.(url) ?? Promise.resolve(),
      },
      getProviderDisplayName: (provider) =>
        getProviderDisplayName(
          provider,
          PROVIDER_DISPLAY_NAMES[provider] ?? provider,
        ),
      getProviderKeyUrl: (provider) => {
        const defaultUrl = PROVIDER_URLS[provider];
        return defaultUrl ? getProviderKeyUrl(provider, defaultUrl) : undefined;
      },
      getApiKeySecretName: (provider) => {
        if (!isApiProvider(provider)) {
          throw new Error(`Unknown API provider: ${provider}`);
        }
        return apiKeySecretName(provider);
      },
      setSecret: (key, value) => secrets.set(key, value),
      deleteSecret: (key) => secrets.delete(key),
      refreshAfterKeyChange: () => refreshAfterCredentialChange(),
    },
    providerConfig: {
      isApiProvider,
      onUnknownProvider: (provider) =>
        options.showErrorMessage?.(`Unknown API provider: ${provider}`),
      setProviderStreaming,
      setProviderEndpoint,
      setGlobalStreaming,
    },
  });

  function readCurrentGitAuthorSettings() {
    return readGitAuthorSettingsFromState(workspaceState);
  }

  function getConfigProvider(): ConfigProvider {
    return options.config ?? platform().config;
  }

  function applyCurrentGitAuthorSettings() {
    return applyGitAuthorSettings(readCurrentGitAuthorSettings());
  }

  function postGitAuthorSettings(
    settings = readCurrentGitAuthorSettings(),
  ): void {
    options.postToRenderer(buildGitAuthorSettingsMessage(settings));
  }

  function postLatexConfigValues(): void {
    options.postToRenderer(
      latexConfigPersistenceController.buildConfigMessage((key) =>
        workspaceState.get(key),
      ),
    );
  }

  function getAgentDirectory(source: AgentSource): Promise<string | undefined> {
    switch (source) {
      case 'custom':
        return getCustomAgentDirectory();
      case 'builtInWorkflow':
        return platform().agentDirectories.builtIn();
      case 'builtInToolUse':
        return platform().agentDirectories.builtInToolUse();
      case 'remote':
        return Promise.resolve(undefined);
    }
  }

  async function postAgentSelectionData(): Promise<void> {
    options.postToRenderer(
      await buildAgentSelectionMessage({
        loadAgents: loadAgentRegistry,
        buildSelectionItems: () => agentCatalogController.buildSelectionItems(),
      }),
    );
  }

  async function postModelSelectionData(): Promise<void> {
    await settingsHost.sendModelSelectionData();
  }

  async function postMainModelOptionsData(): Promise<void> {
    const visibleModels = settingsHost.getVisibleModels();
    const [workflowModelOptions, toolUseModelOptions] = await Promise.all([
      computeModelOptionsData(visibleModels, undefined, {
        agentCategory: AgentCategory.Workflow,
      }),
      computeModelOptionsData(visibleModels, undefined, {
        agentCategory: AgentCategory.ToolUse,
      }),
    ]);
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData: workflowModelOptions,
      optionsDataByCategory: {
        workflow: workflowModelOptions,
        toolUse: toolUseModelOptions,
      },
    });
  }

  async function postMainAgentOptionsData(
    selectedToolUseAgent?: string,
  ): Promise<void> {
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData: await loadAgentOptionsData(),
      ...(selectedToolUseAgent ? { selectedToolUseAgent } : {}),
    });
  }

  async function postCustomAgentDir(): Promise<void> {
    options.postToRenderer(
      await buildCustomAgentDirMessage({
        getCustomDirStatus: () => agentDirectoryController.getCustomDirStatus(),
      }),
    );
  }

  async function postProfileData(): Promise<void> {
    await settingsHost.sendProfileData();
  }

  async function postChatGptAuthStatus(): Promise<void> {
    options.postToRenderer(
      await buildChatGptAuthStatusMessage(getChatGptAuthStatus),
    );
  }

  async function postMemoryData(): Promise<void> {
    await settingsHost.sendMemoryData();
  }

  async function postMemoryPreview(storagePath: string): Promise<void> {
    await settingsHost.sendMemoryPreview({ storagePath }, { onError });
  }

  async function postMemoryEnabled(): Promise<void> {
    await settingsHost.sendMemoryEnabled();
  }

  async function deleteMemory(input: {
    storagePath: string;
    displayPath: string;
  }): Promise<void> {
    await settingsHost.deleteMemory(input);
  }

  async function setMemoryEnabled(enabled: boolean): Promise<void> {
    await settingsHost.setMemoryEnabled(enabled);
  }

  async function setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    await settingsHost.setMemoryPinned(storagePath, pinned);
  }

  async function openMemoryFile(input: { storagePath: string }): Promise<void> {
    const resolvedPath = resolveMemoryStoragePath(input.storagePath);
    await options.openPath?.(StorageFS.fullPath(resolvedPath));
  }

  async function openMemoryFolder(): Promise<void> {
    await StorageFS.ensureDir(resolveMemoryStoragePath());
    await options.openPath?.(StorageFS.fullPath(resolveMemoryStoragePath()));
  }

  async function postToolDashboardData(postOptions?: {
    skipChecks?: boolean;
  }): Promise<void> {
    const cachedResults =
      postOptions?.skipChecks && usesDefaultToolDashboardBuilder
        ? await getCachedToolCheckResults()
        : undefined;
    const items = await buildToolDashboardItems(cachedResults);
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
    });
  }

  async function postLatexSettingsStatus(): Promise<void> {
    const settings =
      (await options.detectLatexSettingsStatus?.()) ??
      (await latexToolingController.detectStatus());
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings,
    });
  }

  function postDesktopCrashReportingStatusMessage(
    status: DesktopCrashReportingStatus,
  ): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
      ...status,
    });
  }

  async function postDesktopCrashReportingStatus(): Promise<void> {
    const status = await getDesktopCrashReportingStatus(globalState, secrets);
    postDesktopCrashReportingStatusMessage(status);
  }

  async function finishDesktopCrashReportingSettingsChange(): Promise<void> {
    const status = await getDesktopCrashReportingStatus(globalState, secrets);
    if (status.enabled && status.configured) {
      await options.initializeCrashReporting?.();
    }
    postDesktopCrashReportingStatusMessage(status);
  }

  function postSuperYoloEnabled(): void {
    options.postToRenderer(
      buildSuperYoloMessage({
        workspaceState,
        globalState,
        getReliabilitySettings: () => [],
      }),
    );
  }

  function postAgentModePresets(): void {
    options.postToRenderer(
      buildAgentModePresetsMessage({
        getCustomPresets: () => agentCatalogController.getCustomPresets(),
        getOrchestratorAgentNames: () =>
          agentCatalogController.getOrchestratorAgentNames(),
      }),
    );
  }

  function postApprovalSettings(): void {
    options.postToRenderer(
      buildApprovalSettingsMessage({
        workspaceState,
        globalState,
        config: getConfigProvider(),
      }),
    );
  }

  /**
   * Deliberate divergence from the extension: no `subscribeGoalStateChanges`
   * push hook here. The initial post below, the webview-ready re-post, and
   * the Goals tab's manual `getList` refresh cover the desktop settings
   * panel — goal state only changes through agent runs, and returning to
   * (or refreshing) the panel re-reads the store, so a live push adds a
   * subscription surface without a user-visible gain.
   */
  function postGoalList(): void {
    options.postToRenderer(goalController.getGoalListMessage());
  }

  async function postInitialSettingsData(): Promise<void> {
    postGitAuthorSettings();
    postLatexConfigValues();
    postGoalList();
    const memoryEnabledPosted = postMemoryEnabled();
    const modelSelectionDataPosted = postModelSelectionData();
    postSuperYoloEnabled();
    postAgentModePresets();
    postApprovalSettings();
    await Promise.all([
      memoryEnabledPosted,
      postMemoryData(),
      historyHandlers.postHistoryData(),
      modelSelectionDataPosted,
      postProfileData(),
      postChatGptAuthStatus(),
      postLatexSettingsStatus(),
      postDesktopCrashReportingStatus(),
      postAgentSelectionData(),
      postCustomAgentDir(),
      postToolDashboardData(),
    ]);
  }

  async function updateGitAuthorSetting(
    key: WorkspaceStateKey,
    value: unknown,
  ): Promise<void> {
    await workspaceState.update(key, value);
    postGitAuthorSettings(applyCurrentGitAuthorSettings());
  }

  async function updateLatexConfigValue(input: {
    field: LatexConfigField;
    value: unknown;
  }): Promise<void> {
    const plan = latexConfigPersistenceController.planUpdate(input);
    if (!plan.ok) {
      onError(
        new Error(`Invalid LaTeX config value for ${input.field}`, {
          cause: plan.error,
        }),
      );
      return;
    }

    await workspaceState.update(plan.update.key, plan.update.value);
    postLatexConfigValues();
  }

  async function updateModelEnabled(input: {
    modelName: string;
    enabled: boolean;
  }): Promise<void> {
    await settingsHost.setModelEnabled(input, {
      afterUpdate: () => invalidateModelOptionsCache(),
      afterPost: () => postMainModelOptionsData(),
    });
  }

  async function updateModelReasoningLevel(input: {
    modelName: string;
    level: ReasoningLevel | null;
  }): Promise<void> {
    await settingsHost.setReasoningLevel(input);
  }

  async function updateHelperModel(modelName: string): Promise<void> {
    await settingsHost.setHelperModel(modelName);
  }

  async function updatePreferShortModelNames(enabled: boolean): Promise<void> {
    await settingsHost.setPreferShortModelNames(enabled);
  }

  async function refreshAfterCredentialChange(): Promise<void> {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    await postProfileData();
    await postModelSelectionData();
    await postMainModelOptionsData();
    await options.onApiKeyChanged?.();
  }

  async function setProviderKey(
    provider: string,
    submittedApiKey?: string,
  ): Promise<void> {
    await settingsHost.setProviderKey(provider, submittedApiKey);
  }

  async function removeProviderKey(provider: string): Promise<void> {
    await settingsHost.removeProviderKey(provider);
  }

  async function openProviderKeyUrl(provider: string): Promise<void> {
    await settingsHost.openProviderKeyUrl(provider);
  }

  async function updateProviderStreaming(input: {
    provider: string;
    enabled: boolean;
  }): Promise<void> {
    await settingsHost.setProviderStreaming(input.provider, input.enabled);
  }

  async function updateProviderEndpoint(input: {
    provider: string;
    endpoint: string;
  }): Promise<void> {
    await settingsHost.setProviderEndpoint(input.provider, input.endpoint);
  }

  async function updateGlobalStreaming(enabled: boolean): Promise<void> {
    await settingsHost.setGlobalStreaming(enabled);
  }

  async function signIn(): Promise<void> {
    if (options.signIn) {
      await options.signIn();
      return;
    }
    await options.showInfoMessage?.(
      'Researcher Access sign-in is not connected in this desktop build. Add a provider API key in Settings > Models to run agents with your own account.',
    );
    await postProfileData();
  }

  async function signOut(): Promise<void> {
    if (options.signOut) {
      await options.signOut();
    } else {
      await postProfileData();
    }
  }

  async function setApiAccessMode(
    mode: 'included' | 'personal',
  ): Promise<void> {
    await settingsHost.setApiAccessMode(mode);
    // Switching included ↔ personal access mode changes the credential
    // predicate (`getUseIncludedModelAccess()`), so refresh the onboarding
    // funnel — otherwise a user enabling included access stays on
    // `needs-credential` until a reload.
    await options.onApiKeyChanged?.();
  }

  async function refreshAfterChatGptAuthChange(): Promise<void> {
    invalidateModelOptionsCache();
    await Promise.all([
      postChatGptAuthStatus(),
      postModelSelectionData(),
      postMainModelOptionsData(),
    ]);
    // ChatGPT sign-in/out is a credential change too: refresh the onboarding
    // funnel so a user who signs in from Settings leaves `needs-credential`
    // without needing a reload.
    await options.onApiKeyChanged?.();
  }

  async function signInChatGpt(signInOptions?: {
    enableSubscription?: boolean;
  }): Promise<void> {
    try {
      if (!options.openExternalUrl) {
        await options.showErrorMessage?.(
          'ChatGPT sign-in is not connected in this desktop build.',
        );
        return;
      }
      const openExternalUrl = options.openExternalUrl;
      const session = await loginWithLoopback({
        coordinator: codexCoordinator(),
        openBrowser: async (url) => {
          await openExternalUrl(url);
          // Fire-and-forget: the dialog is informational, so don't await it.
          // `loginWithLoopback` awaits `openBrowser` before it waits for the
          // OAuth callback, so awaiting a modal here would block sign-in
          // completion until the user dismisses a dialog that the completed
          // browser tab has already made redundant (matches the extension's
          // non-blocking notification). Route a rejection through `onError`
          // instead of letting it surface as an unhandled rejection.
          void Promise.resolve(options.presentChatGptSignInUrl?.(url)).catch(
            onError,
          );
        },
      });
      // The onboarding welcome card's "Sign in with ChatGPT" implies the user
      // wants subscription routing, so enable the preference after a successful
      // login (mirrors the extension's `codexSubscriptionSignIn`). Without this
      // `isCodexSubscriptionActive` stays false (the preference defaults off)
      // and the funnel bounces the user straight back to `needs-credential`.
      // The Settings sign-in command leaves the preference to its own toggle.
      if (signInOptions?.enableSubscription) {
        await setPreferCodexSubscription(true);
      }
      await options.showInfoMessage?.(
        `Signed in with ChatGPT as ${session.email ?? session.accountId ?? 'your account'}.`,
      );
    } catch (error) {
      await options.showErrorMessage?.(
        `ChatGPT sign-in failed: ${toErrorMessage(error)}`,
      );
      onError(error);
    } finally {
      await refreshAfterChatGptAuthChange();
    }
  }

  async function signOutChatGpt(): Promise<void> {
    try {
      await codexCoordinator().signOut();
      await options.showInfoMessage?.('Signed out of ChatGPT.');
    } catch (error) {
      await options.showErrorMessage?.(
        `ChatGPT sign-out failed: ${toErrorMessage(error)}`,
      );
      onError(error);
    } finally {
      await refreshAfterChatGptAuthChange();
    }
  }

  async function setChatGptPreferSubscription(enabled: boolean): Promise<void> {
    try {
      const update = await setPreferCodexSubscription(enabled);
      if (update.effective !== enabled) {
        await options.showInfoMessage?.(
          `A more specific setting still keeps ChatGPT subscription ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await options.showErrorMessage?.(
        `ChatGPT subscription preference update failed: ${toErrorMessage(error)}`,
      );
      onError(error);
    } finally {
      await refreshAfterChatGptAuthChange();
    }
  }

  async function setChatGptSubscriptionToolUseOnly(
    enabled: boolean,
  ): Promise<void> {
    try {
      const update = await setCodexSubscriptionToolUseOnly(enabled);
      if (update.effective !== enabled) {
        await options.showInfoMessage?.(
          `The effective "subscription for tool-use only" setting remains ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await options.showErrorMessage?.(
        `ChatGPT subscription scope update failed: ${toErrorMessage(error)}`,
      );
      onError(error);
    } finally {
      await refreshAfterChatGptAuthChange();
    }
  }

  async function updateDesktopCrashReportingEnabled(
    enabled: boolean,
  ): Promise<void> {
    await setDesktopCrashReportingEnabled(globalState, enabled);
    await finishDesktopCrashReportingSettingsChange();
  }

  async function updateDesktopCrashReportingDsn(): Promise<void> {
    const dsn = await options.promptSecret?.({
      title: 'Set Sentry DSN',
      prompt: 'Enter the Sentry DSN for opt-in desktop crash reports',
    });
    if (dsn == null) return;
    await setDesktopCrashReportingDsn(secrets, dsn);
    await finishDesktopCrashReportingSettingsChange();
  }

  async function refreshAuthDependentData(
    refreshOptions: { deferAgentCatalogRefresh?: boolean } = {},
  ): Promise<void> {
    invalidateModelOptionsCache();
    await postModelSelectionData();
    await postMainModelOptionsData();
    await postProfileData();
    if (refreshOptions.deferAgentCatalogRefresh) return;
    await Promise.all([postAgentSelectionData(), postMainAgentOptionsData()]);
  }

  async function updateAgentSetting(
    key: WorkspaceStateKey,
    value: string,
  ): Promise<void> {
    await setWorkspaceAgentSetting({ workspaceState, globalState }, key, value);
    postApprovalSettings();
  }

  async function updateBashApprovalEnabled(enabled: boolean): Promise<void> {
    await setBashApprovalEnabled(
      { workspaceState, globalState, config: getConfigProvider() },
      enabled,
      BASH_APPROVAL_CONFIG_TARGET,
    );
    postApprovalSettings();
  }

  async function updateBooleanWorkspaceSetting(
    key: WorkspaceStateKey,
    enabled: boolean,
  ): Promise<void> {
    await workspaceState.update(key, enabled);
    postSuperYoloEnabled();
  }

  async function setToolEnabled(
    toolId: string,
    enabled: boolean,
  ): Promise<void> {
    const current = globalState.get<string[]>(
      GlobalStateKey.DISABLED_TOOLS,
      [],
    );
    const disabled = new Set(current);
    if (enabled) {
      disabled.delete(toolId);
    } else {
      disabled.add(toolId);
    }
    await globalState.update(GlobalStateKey.DISABLED_TOOLS, [...disabled]);
    if (usesDefaultToolDashboardBuilder) {
      await refreshDefaultDisabledToolCache();
    }
    await postToolDashboardData({ skipChecks: true });
  }

  async function recheckToolStatus(): Promise<void> {
    const didRefresh = refreshToolAvailability != null;
    if (didRefresh) {
      await refreshToolAvailability();
    }
    await postToolDashboardData({ skipChecks: didRefresh });
  }

  async function runToolCommand(input: {
    toolId: string;
    kind: 'install' | 'auth';
  }): Promise<void> {
    const command = await findToolCommand(input.toolId, input.kind);
    if (!command) return;
    await options.runToolCommand?.({ ...input, command });
  }

  async function updateAgentEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    name: string;
    enabled: boolean;
  }): Promise<void> {
    await agentVisibilityController.setAgentEnabled(input);
    await Promise.all([postAgentSelectionData(), postMainAgentOptionsData()]);
  }

  async function updateAllAgentsEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    enabled: boolean;
  }): Promise<void> {
    await agentVisibilityController.setAllAgentsEnabled(input);
    await Promise.all([postAgentSelectionData(), postMainAgentOptionsData()]);
  }

  async function setCustomAgentDir(): Promise<void> {
    const selectedPath = await options.selectCustomAgentDirectory?.();
    if (!selectedPath) return;

    await agentDirectoryController.setCustomDir(selectedPath);
    await Promise.all([
      postCustomAgentDir(),
      postAgentSelectionData(),
      postMainAgentOptionsData(),
    ]);
  }

  async function resetCustomAgentDir(): Promise<void> {
    await agentDirectoryController.resetCustomDir();
    await Promise.all([
      postCustomAgentDir(),
      postAgentSelectionData(),
      postMainAgentOptionsData(),
    ]);
  }

  async function openAgentYaml(input: {
    source: AgentSource;
    name: string;
  }): Promise<void> {
    const result = agentDirectoryController.planOpenAgentYaml(input);
    if (!result.ok) {
      await options.showErrorMessage?.(
        result.reason === 'missingAgent'
          ? `Agent not found: ${input.name}`
          : `No configuration file found for agent: ${input.name}`,
      );
      return;
    }
    await options.openPath?.(result.path);
  }

  async function openAgentFolder(): Promise<void> {
    const result = await agentDirectoryController.planOpenAgentFolder('custom');
    if (!result.ok) {
      await options.showErrorMessage?.(
        'No custom agent directory is available',
      );
      return;
    }
    await options.openPath?.(result.path);
  }

  async function revealAgentFile(input: {
    source: AgentSource;
    name: string;
  }): Promise<void> {
    const result = agentDirectoryController.planRevealAgentFile(input);
    if (!result.ok) {
      await options.showErrorMessage?.(
        `Agent not found or has no file: ${input.name}`,
      );
      return;
    }
    await (options.revealPath ?? options.openPath)?.(result.path);
  }

  async function applyAgentModePreset(presetId: string): Promise<void> {
    const result = await applyTeamRosterWithPreflight(presetId, {
      catalog: agentCatalogController,
      loadLocalCatalog: () => loadAgentRegistry({ includeRemote: false }),
      canAccessRemoteCatalog:
        options.canAccessRemoteAgentCatalog ??
        (() => SupabaseClient.canAccessRemoteAgentCatalog()),
      choose: (preset, unavailableNames) =>
        options.chooseTeamAvailability?.({
          presetName: preset.name,
          unavailableNames,
        }) ?? Promise.resolve('cancel'),
      signIn:
        options.signInForRemoteAgentCatalog ?? (() => Promise.resolve(false)),
      forceRefreshRemoteCatalog: () =>
        refreshAgentRegistry({ includeRemote: true }),
    });
    if (result.status === 'unknown') {
      await options.showErrorMessage?.(`Unknown team: ${presetId}`);
      return;
    }
    if (result.status === 'cancelled') return;
    if (result.status === 'choice-required') return;
    if (result.status === 'unavailable') {
      await options.showErrorMessage?.(
        `Team "${result.preset.name}" is still unavailable: ${result.unavailableNames.join(', ')}`,
      );
      return;
    }
    await Promise.all([
      postAgentSelectionData(),
      postMainAgentOptionsData(
        agentCatalogController.getPresetToolUseRoot(
          result.preset.toolUseAgents,
        ),
      ),
    ]);
    await options.showInfoMessage?.(`Applied "${result.preset.name}" team`);
  }

  async function saveAgentModePreset(): Promise<void> {
    const name = await options.promptText?.({
      title: 'Save agent team',
      prompt: 'Name for the new team',
    });
    if (!name?.trim()) return;
    await loadAgentRegistry();
    const preset = await agentCatalogController.saveCurrentPreset(name);
    postAgentModePresets();
    await options.showInfoMessage?.(`Saved team "${preset.name}"`);
  }

  async function deleteAgentModePreset(presetId: string): Promise<void> {
    const deleted = await agentCatalogController.deleteCustomPreset(presetId);
    if (!deleted) {
      await options.showErrorMessage?.(`Unknown custom team: ${presetId}`);
      return;
    }
    postAgentModePresets();
  }

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  applyCurrentGitAuthorSettings();

  const StateKeys = WorkspaceStateKey;
  const setGitAuthor = (key: WorkspaceStateKey, value: boolean | string) =>
    updateGitAuthorSetting(key, value);
  const setAgent = (key: WorkspaceStateKey, value: string) =>
    updateAgentSetting(key, value);

  const settingsActions: SettingsViewCommandActions = {
    // WEBVIEW_READY is intercepted in handleMessage below, before reaching
    // the dispatcher, so this entry is never actually invoked — it exists
    // only to satisfy the exhaustive registry type.
    lifecycle: {
      webviewReady: () => {},
      // VS Code-only surfaces with no desktop equivalent.
      openVscodeSettings: unsupported(
        'No VS Code settings in the desktop app.',
      ),
    },
    memory: {
      getData: () => postMemoryData(),
      getPreview: (storagePath) => postMemoryPreview(storagePath),
      openFile: (data) => openMemoryFile(data),
      openFolder: () => openMemoryFolder(),
      delete: (data) => deleteMemory(data),
      setEnabled: (enabled) => setMemoryEnabled(enabled),
      pin: (storagePath) => setMemoryPinned(storagePath, true),
      unpin: (storagePath) => setMemoryPinned(storagePath, false),
    },
    history: historyHandlers.actions,
    profile: {
      signIn: () => signIn(),
      signOut: () => signOut(),
      setApiAccessMode: (mode) => setApiAccessMode(mode),
      setProviderKey: (provider, apiKey) => setProviderKey(provider, apiKey),
      removeProviderKey: (provider) => removeProviderKey(provider),
      openProviderKeyUrl: (provider) => openProviderKeyUrl(provider),
      setProviderStreaming: (provider, enabled) =>
        updateProviderStreaming({ provider, enabled }),
      setProviderEndpoint: (provider, endpoint) =>
        updateProviderEndpoint({ provider, endpoint }),
      setGlobalStreaming: (enabled) => updateGlobalStreaming(enabled),
      setProviderVscodeSetting: unsupported(
        'VS Code provider settings are not applicable in the desktop app.',
      ),
      openExternalUrl: (url) =>
        options.openExternalUrl?.(url) ?? Promise.resolve(),
    },
    modelSelection: {
      setEnabled: (modelName, enabled) =>
        updateModelEnabled({ modelName, enabled }),
      setHelperModel: (modelName) => updateHelperModel(modelName),
      setReasoningLevel: (modelName, level) =>
        updateModelReasoningLevel({ modelName, level }),
      setPreferShortModelNames: (enabled) =>
        updatePreferShortModelNames(enabled),
    },
    orchestration: {
      setAllowOrchestratorKill: (enabled) =>
        updateBooleanWorkspaceSetting(
          StateKeys.ALLOW_ORCHESTRATOR_KILL,
          enabled,
        ),
      setDetachSubagentsOnStop: (enabled) =>
        updateBooleanWorkspaceSetting(
          StateKeys.DETACH_SUBAGENTS_ON_STOP,
          enabled,
        ),
    },
    agentSelection: {
      setEnabled: ({ category, source, name, enabled }) =>
        updateAgentEnabled({ category, source, name, enabled }),
      setAllEnabled: ({ category, source, enabled }) =>
        updateAllAgentsEnabled({ category, source, enabled }),
      openYaml: ({ source, name }) => openAgentYaml({ source, name }),
      openFolder: () => openAgentFolder(),
      create: unsupported(
        'Creating custom agents is not available in the desktop app yet.',
      ),
      customize: unsupported(
        'Customizing agents is not available in the desktop app yet.',
      ),
      deleteCustom: unsupported(
        'Deleting custom agents is not available in the desktop app yet.',
      ),
      revealFile: ({ source, name }) => revealAgentFile({ source, name }),
      viewRemotePrompt: unsupported(
        'Viewing a remote agent prompt is not available in the desktop app yet.',
      ),
      setCustomDir: () => setCustomAgentDir(),
      resetCustomDir: () => resetCustomAgentDir(),
      applyModePreset: (presetId) => applyAgentModePreset(presetId),
      saveModePreset: () => saveAgentModePreset(),
      deleteModePreset: (presetId) => deleteAgentModePreset(presetId),
    },
    gitAuthor: {
      setMarkCommits: (enabled) =>
        setGitAuthor(StateKeys.GIT_MARK_COMMITS, enabled),
      setName: (name) => setGitAuthor(StateKeys.GIT_AUTHOR_NAME, name),
      setEmail: (email) => setGitAuthor(StateKeys.GIT_AUTHOR_EMAIL, email),
      setWorktreeSupport: (enabled) =>
        setGitAuthor(StateKeys.GIT_WORKTREE_SUPPORT, enabled),
    },
    githubSubscriptions: {
      getTokenStatus: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      setToken: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      removeToken: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      openTokenUrl: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      getSubscriptions: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      unsubscribe: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
      openSubscriptionStream: unsupported(
        'GitHub PR subscriptions are not available in the desktop app yet.',
      ),
    },
    chatGpt: {
      signIn: () => signInChatGpt(),
      signOut: () => signOutChatGpt(),
      setPreferSubscription: (enabled) => setChatGptPreferSubscription(enabled),
      setSubscriptionToolUseOnly: (enabled) =>
        setChatGptSubscriptionToolUseOnly(enabled),
    },
    approval: {
      setBashApprovalEnabled: (enabled) => updateBashApprovalEnabled(enabled),
      setCodexSandboxMode: (mode) =>
        setAgent(StateKeys.CODEX_SANDBOX_MODE, mode),
      setCodexReasoningEffort: (effort) =>
        setAgent(StateKeys.CODEX_REASONING_EFFORT, effort),
      setCodexApprovalPolicy: (policy) =>
        setAgent(StateKeys.CODEX_APPROVAL_POLICY, policy),
      setClaudeAgentModel: (model) =>
        setAgent(StateKeys.CLAUDE_AGENT_MODEL, model),
      setClaudeAgentPermissionMode: (mode) =>
        setAgent(StateKeys.CLAUDE_AGENT_PERMISSION_MODE, mode),
      setClaudeAgentEffort: (effort) =>
        setAgent(StateKeys.CLAUDE_AGENT_EFFORT, effort),
    },
    tools: {
      openInstallUrl: (url) =>
        options.openExternalUrl?.(url) ?? Promise.resolve(),
      installExtension: (extensionId) =>
        options.installToolExtension?.(extensionId) ?? Promise.resolve(),
      recheckStatus: () => recheckToolStatus(),
      toggle: (toolId, enabled) => setToolEnabled(toolId, enabled),
      runCommand: ({ toolId, kind }) => runToolCommand({ toolId, kind }),
    },
    latex: {
      applySettings: () => postLatexSettingsStatus(),
      installLatexWorkshop: () =>
        options.installToolExtension?.(LATEX_WORKSHOP_EXT_ID) ??
        Promise.resolve(),
      runInstallCommand: (installCommand) => {
        if (!isAllowedLatexInstallCommand(installCommand)) {
          onError(
            new Error(`Rejected unknown install command: ${installCommand}`),
          );
          return;
        }
        return options.runInstallCommand?.(installCommand) ?? Promise.resolve();
      },
      setConfigValue: ({ field, value }) =>
        updateLatexConfigValue({ field, value }),
    },
    inlineCriticism: {
      getEnabled: unsupported(
        'Inline criticism is not available in the desktop app yet.',
      ),
      setEnabled: unsupported(
        'Inline criticism is not available in the desktop app yet.',
      ),
    },
    goals: {
      getList: postGoalList,
      revealStream: (streamId) =>
        options.revealStream?.(streamId) ?? Promise.resolve(),
    },
    desktopCrashReporting: {
      get: () => postDesktopCrashReportingStatus(),
      setEnabled: (enabled) => updateDesktopCrashReportingEnabled(enabled),
      setDsn: () => updateDesktopCrashReportingDsn(),
    },
  };

  const settingsHandlers = createSettingsViewCommandHandlers(settingsActions);

  return {
    refreshAuthDependentData,
    signInChatGpt,

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
          if (options.sendStartupCatalogData) {
            runAsync(postInitialSettingsData());
          } else {
            postGitAuthorSettings();
            postLatexConfigValues();
            postGoalList();
          }
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
