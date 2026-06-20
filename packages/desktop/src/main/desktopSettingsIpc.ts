import { platform, tryPlatform } from '@platform/platform';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import {
  isAllowedLatexInstallCommand,
  LatexToolingController,
} from '@controllers/settingsView/LatexToolingController';
import { createSettingsMemoryController } from '@controllers/settingsView/SettingsMemoryControllerFactory';
import { deleteAllExecutions, deleteExecution } from '@agent/storage';
import {
  computeAgentOptionsData,
  getAgentsByCategory,
  getVisibleAgents as getVisibleRegistryAgents,
  loadAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { getAllActiveExecutionIds } from '@agent/runtime/SessionHandle';
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
import type { ExecutionId } from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc/settingsViewCommands';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
} from '@shared/constants/latex';
import type { LatexConfigField } from '@shared/constants/latex';
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import {
  dispatchSettingsViewInbound,
  SettingsViewInboundMessageSchema,
  type LatexSettingsStatus,
  type ProviderKeyStatus,
  type ReasoningLevel,
  type SettingsViewInboundHandlerRegistry,
  type ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
import {
  buildApprovalSettingsMessage,
  setBashApprovalEnabled,
  setWorkspaceAgentSetting,
} from '@shared/settingsView/handlers/approvalHandlers';
import { buildHistoryMessage } from '@shared/settingsView/handlers/historyHandlers';
import { buildProfileMessage } from '@shared/settingsView/handlers/profileHandlers';
import {
  buildModelSelectionMessage,
  createModelSelectionController,
} from '@shared/settingsView/handlers/modelSelectionHandlers';
import { createSettingsAgentControllers } from '@shared/settingsView/handlers/agentControllerFactory';
import {
  buildSuperYoloMessage,
  setNestedDelegationMaxDepth,
} from '@shared/settingsView/handlers/superYoloHandlers';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import { MEMORY_STORAGE_ROOT } from '@tools/memory/constants';
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';
import {
  applyGitAuthorSettings,
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
import type { ConfigProvider } from '@platform/interfaces/config';
import type { StateStore } from '@platform/interfaces/state';
import type { PlatformSecrets } from '@platform/secrets';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

type ToolDashboardBuilder = (
  cachedResults?: ExternalToolCheckResult[],
) => Promise<ToolDashboardItem[]>;

export interface DesktopSettingsIpcOptions {
  postToRenderer(message: unknown): void;
  sendStartupCatalogData?: boolean;
  loadAgents?: typeof loadAgents;
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
  openExternalUrl?: (url: string) => Promise<void>;
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
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(): Promise<void>;
}

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const workspaceState = options.workspaceState ?? platform().workspaceState;
  const globalState = options.globalState ?? platform().globalState;
  const onError = options.onError ?? defaultOnError;
  const loadAgentRegistry = options.loadAgents ?? loadAgents;
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
    options.getCustomAgentDirectory ?? (() => getAgentDirectories().custom());
  const latexConfigPersistenceController =
    new LatexConfigPersistenceController();
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
  const modelSelectionController = createModelSelectionController({
    workspaceState,
    globalState,
  });
  const modelListRefresh =
    options.modelListRefresh ??
    refreshDesktopModelListStateIfNeeded({
      globalState,
      onError,
    });
  const memoryController = createSettingsMemoryController({
    globalState,
    prompt: {
      confirm: (message, promptOptions) =>
        options.confirmAction?.(message, promptOptions?.confirmLabel) ??
        Promise.resolve(true),
      warning: async (message) => {
        await options.showInfoMessage?.(message);
      },
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
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      ...settings,
    });
  }

  function readLatexConfigValues() {
    return latexConfigPersistenceController.buildConfigValues((key) =>
      workspaceState.get(key),
    );
  }

  function postLatexConfigValues(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: readLatexConfigValues(),
    });
  }

  function getAgentDirectory(source: AgentSource): Promise<string | undefined> {
    switch (source) {
      case 'custom':
        return getCustomAgentDirectory();
      case 'builtInWorkflow':
        return getAgentDirectories().builtIn();
      case 'builtInToolUse':
        return getAgentDirectories().builtInToolUse();
      case 'remote':
        return Promise.resolve(undefined);
    }
  }

  async function postAgentSelectionData(): Promise<void> {
    await loadAgentRegistry();
    const { workflow, toolUse } = agentCatalogController.buildSelectionItems();
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      workflow,
      toolUse,
    });
  }

  async function postModelSelectionData(): Promise<void> {
    await modelListRefresh;
    options.postToRenderer(
      await buildModelSelectionMessage(modelSelectionController),
    );
  }

  async function postMainModelOptionsData(): Promise<void> {
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData: await computeModelOptionsData(
        modelSelectionController.getVisibleModels(),
      ),
    });
  }

  async function postMainAgentOptionsData(): Promise<void> {
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      optionsData: await loadAgentOptionsData(),
    });
  }

  async function postCustomAgentDir(): Promise<void> {
    const status = await agentDirectoryController.getCustomDirStatus();
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      ...status,
    });
  }

  async function getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
    const statuses = await loadApiKeyStatusMap(secrets, API_PROVIDERS);
    return API_PROVIDERS.map((provider) => ({
      provider,
      displayName: getProviderDisplayName(
        provider,
        PROVIDER_DISPLAY_NAMES[provider] ?? provider,
      ),
      status: statuses[provider],
      keyUrl: getProviderKeyUrl(provider, PROVIDER_URLS[provider] ?? ''),
      streaming: getProviderStreaming(provider),
      customEndpoint: getProviderEndpoint(provider),
      supportsCustomEndpoint: supportsCustomEndpoint(provider),
      vscodeSettings: [],
    }));
  }

  async function postProfileData(): Promise<void> {
    const message = await buildProfileMessage({
      getProviderKeyStatuses: () => getProviderKeyStatuses(),
    });
    options.postToRenderer(message);
  }

  async function postMemoryData(): Promise<void> {
    options.postToRenderer(await memoryController.getMemoryDataMessage());
  }

  async function postMemoryPreview(storagePath: string): Promise<void> {
    try {
      options.postToRenderer(
        await memoryController.getMemoryPreviewMessage(storagePath),
      );
    } catch (error) {
      onError(error);
      options.postToRenderer(
        memoryController.getMemoryPreviewErrorMessage(storagePath),
      );
    }
  }

  async function postMemoryEnabled(): Promise<void> {
    options.postToRenderer(memoryController.getMemoryEnabledMessage());
  }

  async function deleteMemory(input: {
    storagePath: string;
    displayPath: string;
  }): Promise<void> {
    const message = await memoryController.deleteMemory(input);
    if (message) options.postToRenderer(message);
  }

  async function setMemoryEnabled(enabled: boolean): Promise<void> {
    const message = await memoryController.setMemoryEnabled(enabled);
    if (message) options.postToRenderer(message);
  }

  async function setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    const message = pinned
      ? await memoryController.pinMemory(storagePath)
      : await memoryController.unpinMemory(storagePath);
    if (message) options.postToRenderer(message);
  }

  async function openMemoryFile(input: { storagePath: string }): Promise<void> {
    const resolvedPath = resolveMemoryStoragePath(input.storagePath);
    await options.openPath?.(StorageFS.fullPath(resolvedPath));
  }

  async function openMemoryFolder(): Promise<void> {
    await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
    await options.openPath?.(StorageFS.fullPath(MEMORY_STORAGE_ROOT));
  }

  async function postHistoryData(): Promise<void> {
    options.postToRenderer(await buildHistoryMessage());
  }

  async function deleteHistoryItem(historyId: string): Promise<void> {
    if (getAllActiveExecutionIds().includes(historyId)) {
      await options.showInfoMessage?.('Cannot delete a running execution');
      return;
    }

    const deleted = await deleteExecution(historyId as ExecutionId);
    if (!deleted) {
      await options.showInfoMessage?.(`History item not found: ${historyId}`);
      return;
    }
    await postHistoryData();
  }

  async function clearHistory(): Promise<void> {
    await deleteAllExecutions(new Set(getAllActiveExecutionIds()));
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
    });
  }

  async function showUnsupportedHistoryAction(action: string): Promise<void> {
    await options.showInfoMessage?.(
      `${action} from history is not available in the desktop app yet.`,
    );
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
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: agentCatalogController.getCustomPresets(),
    });
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

  async function postInitialSettingsData(): Promise<void> {
    postGitAuthorSettings();
    postLatexConfigValues();
    const memoryEnabledPosted = postMemoryEnabled();
    const modelSelectionDataPosted = postModelSelectionData();
    postSuperYoloEnabled();
    postAgentModePresets();
    postApprovalSettings();
    await Promise.all([
      memoryEnabledPosted,
      postMemoryData(),
      postHistoryData(),
      modelSelectionDataPosted,
      postProfileData(),
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
    await modelSelectionController.setModelEnabled(input);
    invalidateModelOptionsCache();
    await postModelSelectionData();
    await postMainModelOptionsData();
  }

  async function updateModelReasoningLevel(input: {
    modelName: string;
    level: ReasoningLevel | null;
  }): Promise<void> {
    await modelSelectionController.setReasoningLevel(input);
    await postModelSelectionData();
  }

  async function updateHelperModel(modelName: string): Promise<void> {
    await modelSelectionController.setHelperModel(modelName);
    await postModelSelectionData();
  }

  async function updatePreferShortModelNames(enabled: boolean): Promise<void> {
    await modelSelectionController.setPreferShortModelNames(enabled);
    await postModelSelectionData();
  }

  async function refreshAfterCredentialChange(): Promise<void> {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    await postProfileData();
    await postModelSelectionData();
    await postMainModelOptionsData();
  }

  async function setProviderKey(
    provider: string,
    submittedApiKey?: string,
  ): Promise<void> {
    if (!isApiProvider(provider)) {
      await options.showErrorMessage?.(`Unknown API provider: ${provider}`);
      return;
    }
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
    const apiKey =
      submittedApiKey?.trim() ||
      (
        await options.promptSecret?.({
          title: `Set ${displayName} API key`,
          prompt: `Enter ${displayName} API key`,
        })
      )?.trim();
    if (!apiKey) return;

    await secrets.set(apiKeySecretName(provider), apiKey);
    await options.showInfoMessage?.(`${displayName} API key has been set`);
    await refreshAfterCredentialChange();
  }

  async function removeProviderKey(provider: string): Promise<void> {
    if (!isApiProvider(provider)) {
      await options.showErrorMessage?.(`Unknown API provider: ${provider}`);
      return;
    }
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
    await secrets.delete(apiKeySecretName(provider));
    await options.showInfoMessage?.(`${displayName} API key has been removed`);
    await refreshAfterCredentialChange();
  }

  async function openProviderKeyUrl(provider: string): Promise<void> {
    const defaultUrl = PROVIDER_URLS[provider];
    if (!defaultUrl) return;
    await options.openExternalUrl?.(getProviderKeyUrl(provider, defaultUrl));
  }

  async function updateProviderStreaming(input: {
    provider: string;
    enabled: boolean;
  }): Promise<void> {
    await setProviderStreaming(input.provider, input.enabled);
    await postProfileData();
  }

  async function updateProviderEndpoint(input: {
    provider: string;
    endpoint: string;
  }): Promise<void> {
    await setProviderEndpoint(input.provider, input.endpoint);
    await postProfileData();
  }

  async function updateGlobalStreaming(enabled: boolean): Promise<void> {
    await setGlobalStreaming(enabled);
    await postProfileData();
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
    await options.setApiAccessMode?.(mode);
    if (
      mode === 'included' &&
      globalState.get<boolean>(GlobalStateKey.USE_OPENROUTER, false)
    ) {
      await globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    }
    invalidateModelOptionsCache();
    await Promise.all([postProfileData(), postModelSelectionData()]);
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

  async function refreshAuthDependentData(): Promise<void> {
    invalidateModelOptionsCache();
    await postModelSelectionData();
    await postMainModelOptionsData();
    await Promise.all([
      postProfileData(),
      postAgentSelectionData(),
      postMainAgentOptionsData(),
    ]);
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
      'workspace',
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

  async function updateNestedDelegationMaxDepth(value: number): Promise<void> {
    await setNestedDelegationMaxDepth({ workspaceState, globalState }, value);
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
    await loadAgentRegistry();
    const result = await agentCatalogController.applyPreset(presetId);
    if (!result.ok) {
      await options.showErrorMessage?.(`Unknown team: ${presetId}`);
      return;
    }
    await Promise.all([postAgentSelectionData(), postMainAgentOptionsData()]);
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

  // Registry of settings commands → handlers. The dispatcher parses the
  // message, looks up the handler by `command`, and routes async rejections to
  // `onError` (replacing the former per-case `runAsync` wrapper). WEBVIEW_READY
  // is intentionally absent — it is a broadcast handled in `handleMessage` so
  // sibling handlers (startup, onboarding) still receive it.
  const settingsHandlers: SettingsViewInboundHandlerRegistry = {
    [SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION]: () =>
      postAgentSelectionData(),
    [SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION]: () =>
      postModelSelectionData(),
    [SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA]: () => postMemoryData(),
    [SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW]: (d) =>
      postMemoryPreview(d.storagePath),
    [SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED]: () => postMemoryEnabled(),
    [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE]: (d) => openMemoryFile(d),
    [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]: () => openMemoryFolder(),
    [SETTINGS_VIEW_COMMANDS.DELETE_MEMORY]: (d) => deleteMemory(d),
    [SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED]: (d) =>
      setMemoryEnabled(d.enabled),
    [SETTINGS_VIEW_COMMANDS.PIN_MEMORY]: (d) =>
      setMemoryPinned(d.storagePath, true),
    [SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY]: (d) =>
      setMemoryPinned(d.storagePath, false),
    [SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA]: () => postHistoryData(),
    [SETTINGS_VIEW_COMMANDS.DELETE_AGENT]: (d) =>
      deleteHistoryItem(d.historyId),
    [SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY]: () => clearHistory(),
    [SETTINGS_VIEW_COMMANDS.RERUN_AGENT]: () =>
      showUnsupportedHistoryAction('Rerun'),
    [SETTINGS_VIEW_COMMANDS.RESTORE_AGENT]: () =>
      showUnsupportedHistoryAction('Setup'),
    [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD]: () =>
      showUnsupportedHistoryAction('Markdown export'),
    [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX]: () =>
      showUnsupportedHistoryAction('LaTeX export'),
    [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML]: () =>
      showUnsupportedHistoryAction('HTML export'),
    [SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA]: () => postProfileData(),
    [SETTINGS_VIEW_COMMANDS.SIGN_IN]: () => signIn(),
    [SETTINGS_VIEW_COMMANDS.SIGN_OUT]: () => signOut(),
    [SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE]: (d) =>
      setApiAccessMode(d.mode),
    [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY]: (d) =>
      setProviderKey(d.provider, d.apiKey),
    [SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY]: (d) =>
      removeProviderKey(d.provider),
    [SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL]: (d) =>
      openProviderKeyUrl(d.provider),
    [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_STREAMING]: (d) =>
      updateProviderStreaming({ provider: d.provider, enabled: d.enabled }),
    [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_ENDPOINT]: (d) =>
      updateProviderEndpoint({ provider: d.provider, endpoint: d.endpoint }),
    [SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING]: (d) =>
      updateGlobalStreaming(d.enabled),
    [SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL]: (d) =>
      options.openExternalUrl?.(d.url) ?? Promise.resolve(),
    [SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED]: (d) =>
      updateModelEnabled({ modelName: d.modelName, enabled: d.enabled }),
    [SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL]: (d) =>
      updateHelperModel(d.modelName),
    [SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL]: (d) =>
      updateModelReasoningLevel({ modelName: d.modelName, level: d.level }),
    [SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES]: (d) =>
      updatePreferShortModelNames(d.enabled),
    [SETTINGS_VIEW_COMMANDS.GET_APPROVAL_SETTINGS]: () =>
      postApprovalSettings(),
    [SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED]: () =>
      postSuperYoloEnabled(),
    [SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED]: () =>
      postSuperYoloEnabled(),
    [SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL]: (d) =>
      updateBooleanWorkspaceSetting(
        WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
        d.enabled,
      ),
    [SETTINGS_VIEW_COMMANDS.SET_DETACH_SUBAGENTS_ON_STOP]: (d) =>
      updateBooleanWorkspaceSetting(
        WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
        d.enabled,
      ),
    [SETTINGS_VIEW_COMMANDS.SET_NESTED_DELEGATION_MAX_DEPTH]: (d) =>
      updateNestedDelegationMaxDepth(d.value),
    [SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED]: (d) =>
      updateBashApprovalEnabled(d.enabled),
    [SETTINGS_VIEW_COMMANDS.SET_CODEX_SANDBOX_MODE]: (d) =>
      updateAgentSetting(WorkspaceStateKey.CODEX_SANDBOX_MODE, d.mode),
    [SETTINGS_VIEW_COMMANDS.SET_CODEX_REASONING_EFFORT]: (d) =>
      updateAgentSetting(WorkspaceStateKey.CODEX_REASONING_EFFORT, d.effort),
    [SETTINGS_VIEW_COMMANDS.SET_CODEX_APPROVAL_POLICY]: (d) =>
      updateAgentSetting(WorkspaceStateKey.CODEX_APPROVAL_POLICY, d.policy),
    [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_MODEL]: (d) =>
      updateAgentSetting(WorkspaceStateKey.CLAUDE_AGENT_MODEL, d.model),
    [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_PERMISSION_MODE]: (d) =>
      updateAgentSetting(
        WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
        d.mode,
      ),
    [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_EFFORT]: (d) =>
      updateAgentSetting(WorkspaceStateKey.CLAUDE_AGENT_EFFORT, d.effort),
    [SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA]: () =>
      postToolDashboardData(),
    [SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL]: (d) =>
      options.openExternalUrl?.(d.url) ?? Promise.resolve(),
    [SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION]: (d) =>
      options.installToolExtension?.(d.extensionId) ?? Promise.resolve(),
    [SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS]: () => recheckToolStatus(),
    [SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL]: (d) =>
      setToolEnabled(d.toolId, d.enabled),
    [SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND]: (d) =>
      runToolCommand({ toolId: d.toolId, kind: d.kind }),
    [SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED]: (d) =>
      updateAgentEnabled({
        category: d.category,
        source: d.agentSource,
        name: d.agentName,
        enabled: d.enabled,
      }),
    [SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED]: (d) =>
      updateAllAgentsEnabled({
        category: d.category,
        source: d.source,
        enabled: d.enabled,
      }),
    [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML]: (d) =>
      openAgentYaml({ source: d.agentSource, name: d.agentName }),
    [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER]: () => openAgentFolder(),
    [SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE]: (d) =>
      revealAgentFile({ source: d.agentSource, name: d.agentName }),
    [SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR]: () => postCustomAgentDir(),
    [SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR]: () => setCustomAgentDir(),
    [SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR]: () =>
      resetCustomAgentDir(),
    [SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS]: () =>
      postAgentModePresets(),
    [SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET]: (d) =>
      applyAgentModePreset(d.presetId),
    [SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET]: () =>
      saveAgentModePreset(),
    [SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET]: (d) =>
      deleteAgentModePreset(d.presetId),
    [SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS]: () =>
      postGitAuthorSettings(),
    [SETTINGS_VIEW_COMMANDS.GET_DESKTOP_CRASH_REPORTING]: () =>
      postDesktopCrashReportingStatus(),
    [SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_ENABLED]: (d) =>
      updateDesktopCrashReportingEnabled(d.enabled),
    [SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_DSN]: () =>
      updateDesktopCrashReportingDsn(),
    [SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS]: () =>
      postLatexSettingsStatus(),
    [SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS]: () =>
      postLatexSettingsStatus(),
    [SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP]: () =>
      options.installToolExtension?.(LATEX_WORKSHOP_EXT_ID) ??
      Promise.resolve(),
    [SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND]: (d) => {
      if (!isAllowedLatexInstallCommand(d.installCommand)) {
        onError(
          new Error(`Rejected unknown install command: ${d.installCommand}`),
        );
        return;
      }
      return options.runInstallCommand?.(d.installCommand) ?? Promise.resolve();
    },
    [SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES]: () =>
      postLatexConfigValues(),
    [SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE]: (d) =>
      updateLatexConfigValue({ field: d.field, value: d.value }),
    [SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS]: (d) =>
      updateGitAuthorSetting(WorkspaceStateKey.GIT_MARK_COMMITS, d.enabled),
    [SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME]: (d) =>
      updateGitAuthorSetting(WorkspaceStateKey.GIT_AUTHOR_NAME, d.name),
    [SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL]: (d) =>
      updateGitAuthorSetting(WorkspaceStateKey.GIT_AUTHOR_EMAIL, d.email),
    [SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT]: (d) =>
      updateGitAuthorSetting(WorkspaceStateKey.GIT_WORKTREE_SUPPORT, d.enabled),
  };

  return {
    refreshAuthDependentData,

    handleMessage(message: DesktopCommandMessage) {
      // WEBVIEW_READY is a broadcast: act on it but return false so sibling
      // handlers (startup, onboarding) in the chain still receive it.
      const parsed = SettingsViewInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      if (parsed.data.command === SETTINGS_VIEW_COMMANDS.WEBVIEW_READY) {
        if (parsed.data.view === 'settings') {
          if (options.sendStartupCatalogData) {
            runAsync(postInitialSettingsData());
          } else {
            postGitAuthorSettings();
            postLatexConfigValues();
          }
        }
        return false;
      }
      return dispatchSettingsViewInbound(message, settingsHandlers, onError);
    },
  };
}
