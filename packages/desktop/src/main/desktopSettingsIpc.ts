import { platform, tryPlatform } from '@platform/platform';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import { LatexToolingController } from '@controllers/settingsView/LatexToolingController';
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogState,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import { SettingsAgentVisibilityController } from '@controllers/settingsView/SettingsAgentVisibilityController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import {
  computeAgentOptionsData,
  getAgent,
  getToolUseAgents,
  getWorkflowAgents,
  loadAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { MAX_TIER, ULTRA_TIER } from '@auth/sharedConfig';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  type ApiProvider,
} from '@model/apiProviders';
import {
  DEFAULT_MODELS,
  buildBasicModelOptionsData,
} from '@model/modelOptionsBasic';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
} from '@shared/constants/latex';
import {
  NESTED_DELEGATION_DEPTH_RANGE,
  clampNestedDelegationDepth,
} from '@shared/constants/delegationPolicy';
import type { LatexConfigField } from '@shared/constants/latex';
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import {
  SettingsViewInboundMessageSchema,
  type LatexSettingsStatus,
  type ProviderKeyStatus,
  type ReasoningLevel,
  type ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
import type { ExternalToolCheckResult } from '@tools/toolAvailability';
import {
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
} from '@tools/codexConfig';
import { BASH_APPROVAL_CONFIG_KEY } from '@tools/approval/bashApproval';
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
  getGlobalStreaming,
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
  unauthenticatedProfileData,
  type DesktopAuthProfileData,
} from './desktopSupabaseAuth.js';
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
  globalState?: StateStore;
  workspaceState?: StateStore;
  config?: ConfigProvider;
  buildToolDashboardItems?: ToolDashboardBuilder;
  refreshToolAvailability?: () => Promise<void>;
  getCustomAgentDirectory?: () => Promise<string>;
  selectCustomAgentDirectory?: () => Promise<string | undefined>;
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
  signIn?: () => Promise<void>;
  signOut?: () => Promise<void>;
  getAuthProfileData?: () => Promise<DesktopAuthProfileData>;
  setApiAccessMode?: (mode: 'included' | 'personal') => Promise<void>;
  secrets?: PlatformSecrets;
  detectLatexSettingsStatus?: () => Promise<LatexSettingsStatus>;
  runInstallCommand?: (command: string) => Promise<void>;
  runToolCommand?: (input: {
    toolId: string;
    command: string;
    kind: 'install' | 'auth';
  }) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface DesktopSettingsIpc extends DesktopMessageHandler {
  refreshAuthDependentData(): Promise<void>;
}

const emptySecrets: PlatformSecrets = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

async function buildDefaultToolDashboardItems(
  cachedResults?: ExternalToolCheckResult[],
): Promise<ToolDashboardItem[]> {
  const { buildToolDashboardItems } =
    await import('@settingsView/utils/toolDashboardData');
  return buildToolDashboardItems(cachedResults);
}

async function refreshDefaultToolAvailability(): Promise<void> {
  const { refreshToolAvailability } = await import('@tools/toolAvailability');
  await refreshToolAvailability();
}

async function getCachedToolCheckResults(): Promise<
  ExternalToolCheckResult[] | undefined
> {
  const { getLastCheckResults } = await import('@tools/toolAvailability');
  return getLastCheckResults() ?? undefined;
}

async function refreshDefaultDisabledToolCache(): Promise<void> {
  const { refreshDisabledToolCache } = await import('@tools/toolAvailability');
  refreshDisabledToolCache();
}

async function findToolCommand(
  toolId: string,
  kind: 'install' | 'auth',
): Promise<string | undefined> {
  const { findExternalToolDef } = await import('@tools/externalToolDefs');
  const def = findExternalToolDef(toolId);
  return kind === 'install' ? def?.installCommand : def?.authCommand;
}

function isApiProvider(provider: string): provider is ApiProvider {
  return (API_PROVIDERS as readonly string[]).includes(provider);
}

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const workspaceState = options.workspaceState ?? platform().workspaceState;
  const globalState = options.globalState ?? platform().globalState;
  const onError =
    options.onError ??
    ((error) => {
      console.error(error);
    });
  const loadAgentRegistry = options.loadAgents ?? loadAgents;
  const loadAgentOptionsData =
    options.loadAgentOptionsData ?? computeAgentOptionsData;
  const usesDefaultToolDashboardBuilder =
    options.buildToolDashboardItems == null;
  const buildToolDashboardItems =
    options.buildToolDashboardItems ?? buildDefaultToolDashboardItems;
  const refreshToolAvailability =
    options.refreshToolAvailability ?? refreshDefaultToolAvailability;
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
  const agentCatalogState: SettingsAgentCatalogState = {
    getEnabledAgentKeys: (category) =>
      workspaceState.get<string[]>(getAgentStateKey(category)),
    setEnabledAgentKeys: async (category, enabledKeys) => {
      await workspaceState.update(getAgentStateKey(category), enabledKeys);
    },
    getAgents,
    getVisibleAgents: getAgents,
    getCustomPresetsRaw: () =>
      workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
    setCustomPresets: async (presets) => {
      await workspaceState.update(
        WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
        presets,
      );
    },
  };
  const agentCatalogController = new SettingsAgentCatalogController({
    state: agentCatalogState,
  });
  const agentDirectoryController = new SettingsAgentDirectoryController({
    state: {
      getConfiguredCustomDir: () =>
        globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, ''),
      setConfiguredCustomDir: async (customDir) => {
        await globalState.update(
          GlobalStateKey.CUSTOM_AGENT_DIR,
          customDir || undefined,
        );
      },
      getCustomDir: getCustomAgentDirectory,
      getSourceDir: getAgentDirectory,
      getAgent: (source, name) => getAgent(`${source}:${name}`) ?? null,
    },
  });
  const agentVisibilityController = new SettingsAgentVisibilityController({
    state: {
      getEnabledAgentKeys: agentCatalogState.getEnabledAgentKeys,
      setEnabledAgentKeys: agentCatalogState.setEnabledAgentKeys,
      getAgents: (category) =>
        getAgents(category).map((entry) => ({
          source: entry.source,
          name: entry.name,
        })),
    },
  });
  const modelSelectionController = new SettingsModelSelectionController({
    state: {
      getEnabledModels: () =>
        globalState.get<string[]>(
          GlobalStateKey.ENABLED_MODELS,
          DEFAULT_MODELS,
        ),
      setEnabledModels: async (models) => {
        await globalState.update(GlobalStateKey.ENABLED_MODELS, models);
      },
      getHelperModel: () => globalState.get(GlobalStateKey.HELPER_MODEL),
      setHelperModel: async (model) => {
        await globalState.update(GlobalStateKey.HELPER_MODEL, model);
      },
      getReasoningLevelOverrides: () =>
        globalState.get<Record<string, string>>(
          GlobalStateKey.REASONING_LEVELS,
          {},
        ),
      setReasoningLevelOverrides: async (overrides) => {
        await globalState.update(GlobalStateKey.REASONING_LEVELS, overrides);
      },
      getPreferShortModelNames: () =>
        globalState.get(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
      setPreferShortModelNames: async (enabled) => {
        await globalState.update(
          GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
          enabled,
        );
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

  function applyAndPostGitAuthorSettings(): void {
    postGitAuthorSettings(applyCurrentGitAuthorSettings());
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

  function getAgents(category: AgentCategory): AgentEntry[] {
    return category === 'workflow' ? getWorkflowAgents() : getToolUseAgents();
  }

  function getAgentStateKey(category: AgentCategory): WorkspaceStateKey {
    return category === 'workflow'
      ? WorkspaceStateKey.ENABLED_AGENTS
      : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;
  }

  function getAgentDirectory(source: AgentSource): Promise<string | undefined> {
    const directories = getAgentDirectories();
    switch (source) {
      case 'custom':
        return getCustomAgentDirectory();
      case 'builtInWorkflow':
        return directories.builtIn();
      case 'builtInToolUse':
        return directories.builtInToolUse();
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

  function postModelSelectionData(): void {
    const data = modelSelectionController.buildSelectionData();
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ...data,
    });
  }

  function postMainModelOptionsData(): void {
    invalidateModelOptionsCache();
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData: buildBasicModelOptionsData(
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
    const authProfile =
      (await options.getAuthProfileData?.()) ?? unauthenticatedProfileData();
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ...authProfile,
      tierConstants: { ultra: ULTRA_TIER, max: MAX_TIER },
      providerKeyStatuses: await getProviderKeyStatuses(),
      globalStreamingDefault: getGlobalStreaming(),
    });
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

  function postSuperYoloEnabled(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
      enabled: true,
      reliabilitySettings: [],
      allowOrchestratorKill: workspaceState.get<boolean>(
        WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
        true,
      ),
      detachSubagentsOnStop: workspaceState.get<boolean>(
        WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
        false,
      ),
      nestedDelegationMaxDepth: clampNestedDelegationDepth(
        workspaceState.get<number>(
          WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH,
          NESTED_DELEGATION_DEPTH_RANGE.default,
        ),
      ),
    });
  }

  function postAgentModePresets(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: agentCatalogController.getCustomPresets(),
    });
  }

  function postApprovalSettings(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      bashApprovalEnabled: getConfigProvider().get<boolean>(
        BASH_APPROVAL_CONFIG_KEY,
        true,
      ),
      codexSandboxMode: parseCodexSandboxMode(
        workspaceState.get<string>(
          WorkspaceStateKey.CODEX_SANDBOX_MODE,
          'workspace-write',
        ) ?? 'workspace-write',
      ),
      codexReasoningEffort: parseCodexReasoningEffort(
        workspaceState.get<string>(
          WorkspaceStateKey.CODEX_REASONING_EFFORT,
          'high',
        ) ?? 'high',
      ),
      codexApprovalPolicy: parseCodexApprovalPolicy(
        workspaceState.get<string>(
          WorkspaceStateKey.CODEX_APPROVAL_POLICY,
          'never',
        ) ?? 'never',
      ),
    });
  }

  async function postInitialSettingsData(): Promise<void> {
    postGitAuthorSettings();
    postLatexConfigValues();
    postModelSelectionData();
    postSuperYoloEnabled();
    postAgentModePresets();
    postApprovalSettings();
    await Promise.all([
      postProfileData(),
      postLatexSettingsStatus(),
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
    applyAndPostGitAuthorSettings();
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
    postModelSelectionData();
    postMainModelOptionsData();
  }

  async function updateModelReasoningLevel(input: {
    modelName: string;
    level: ReasoningLevel | null;
  }): Promise<void> {
    await modelSelectionController.setReasoningLevel(input);
    postModelSelectionData();
  }

  async function updateHelperModel(modelName: string): Promise<void> {
    await modelSelectionController.setHelperModel(modelName);
    postModelSelectionData();
  }

  async function updatePreferShortModelNames(enabled: boolean): Promise<void> {
    await modelSelectionController.setPreferShortModelNames(enabled);
    postModelSelectionData();
  }

  async function refreshAfterCredentialChange(): Promise<void> {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    await postProfileData();
    postModelSelectionData();
    postMainModelOptionsData();
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
    const trimmedSubmittedKey = submittedApiKey?.trim();
    const apiKey =
      trimmedSubmittedKey ||
      (await options.promptSecret?.({
        title: `Set ${displayName} API key`,
        prompt: `Enter ${displayName} API key`,
      }));
    const trimmed = apiKey?.trim();
    if (!trimmed) return;

    await secrets.set(apiKeySecretName(provider), trimmed);
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
    } else {
      await options.showInfoMessage?.(
        'Researcher Access sign-in is not connected in this desktop build. Add a provider API key in Settings > Models to run agents with your own account.',
      );
    }
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

  async function refreshAuthDependentData(): Promise<void> {
    postModelSelectionData();
    postMainModelOptionsData();
    await Promise.all([
      postProfileData(),
      postAgentSelectionData(),
      postMainAgentOptionsData(),
    ]);
  }

  async function updateCodexSetting(
    key: WorkspaceStateKey,
    value: string,
  ): Promise<void> {
    await workspaceState.update(key, value);
    postApprovalSettings();
  }

  async function updateBashApprovalEnabled(enabled: boolean): Promise<void> {
    await getConfigProvider().update(
      BASH_APPROVAL_CONFIG_KEY,
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
    await workspaceState.update(
      WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH,
      clampNestedDelegationDepth(value),
    );
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
    await refreshToolAvailability();
    await postToolDashboardData({ skipChecks: true });
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
    await agentCatalogController.saveCurrentPreset(name);
    postAgentModePresets();
  }

  async function deleteAgentModePreset(presetId: string): Promise<void> {
    await agentCatalogController.deleteCustomPreset(presetId);
    postAgentModePresets();
  }

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  applyCurrentGitAuthorSettings();

  return {
    refreshAuthDependentData,

    handleMessage(message: DesktopCommandMessage) {
      const result = SettingsViewInboundMessageSchema.safeParse(message);
      if (!result.success) return false;

      switch (result.data.command) {
        case SETTINGS_VIEW_COMMANDS.WEBVIEW_READY:
          if (result.data.view === 'settings') {
            if (options.sendStartupCatalogData) {
              runAsync(postInitialSettingsData());
            } else {
              postGitAuthorSettings();
              postLatexConfigValues();
            }
          }
          return false;
        case SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION:
          runAsync(postAgentSelectionData());
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION:
          postModelSelectionData();
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA:
          runAsync(postProfileData());
          return true;
        case SETTINGS_VIEW_COMMANDS.SIGN_IN:
          runAsync(signIn());
          return true;
        case SETTINGS_VIEW_COMMANDS.SIGN_OUT:
          runAsync(signOut());
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE:
          runAsync(setApiAccessMode(result.data.mode));
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY:
          runAsync(setProviderKey(result.data.provider, result.data.apiKey));
          return true;
        case SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY:
          runAsync(removeProviderKey(result.data.provider));
          return true;
        case SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL:
          runAsync(openProviderKeyUrl(result.data.provider));
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_PROVIDER_STREAMING:
          runAsync(
            updateProviderStreaming({
              provider: result.data.provider,
              enabled: result.data.enabled,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_PROVIDER_ENDPOINT:
          runAsync(
            updateProviderEndpoint({
              provider: result.data.provider,
              endpoint: result.data.endpoint,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING:
          runAsync(updateGlobalStreaming(result.data.enabled));
          return true;
        case SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL:
          runAsync(
            options.openExternalUrl?.(result.data.url) ?? Promise.resolve(),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED:
          runAsync(
            updateModelEnabled({
              modelName: result.data.modelName,
              enabled: result.data.enabled,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL:
          runAsync(updateHelperModel(result.data.modelName));
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL:
          runAsync(
            updateModelReasoningLevel({
              modelName: result.data.modelName,
              level: result.data.level,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES:
          runAsync(updatePreferShortModelNames(result.data.enabled));
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_APPROVAL_SETTINGS:
          postApprovalSettings();
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED:
          postSuperYoloEnabled();
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED:
          postSuperYoloEnabled();
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL:
          runAsync(
            updateBooleanWorkspaceSetting(
              WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
              result.data.enabled,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_DETACH_SUBAGENTS_ON_STOP:
          runAsync(
            updateBooleanWorkspaceSetting(
              WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
              result.data.enabled,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_NESTED_DELEGATION_MAX_DEPTH:
          runAsync(updateNestedDelegationMaxDepth(result.data.value));
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED:
          runAsync(updateBashApprovalEnabled(result.data.enabled));
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_CODEX_SANDBOX_MODE:
          runAsync(
            updateCodexSetting(
              WorkspaceStateKey.CODEX_SANDBOX_MODE,
              result.data.mode,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_CODEX_REASONING_EFFORT:
          runAsync(
            updateCodexSetting(
              WorkspaceStateKey.CODEX_REASONING_EFFORT,
              result.data.effort,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_CODEX_APPROVAL_POLICY:
          runAsync(
            updateCodexSetting(
              WorkspaceStateKey.CODEX_APPROVAL_POLICY,
              result.data.policy,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA:
          runAsync(postToolDashboardData());
          return true;
        case SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL:
          runAsync(
            options.openExternalUrl?.(result.data.url) ?? Promise.resolve(),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION:
          runAsync(
            options.installToolExtension?.(result.data.extensionId) ??
              Promise.resolve(),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS:
          runAsync(recheckToolStatus());
          return true;
        case SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL:
          runAsync(setToolEnabled(result.data.toolId, result.data.enabled));
          return true;
        case SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND:
          runAsync(
            runToolCommand({
              toolId: result.data.toolId,
              kind: result.data.kind,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED:
          runAsync(
            updateAgentEnabled({
              category: result.data.category,
              source: result.data.agentSource,
              name: result.data.agentName,
              enabled: result.data.enabled,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED:
          runAsync(
            updateAllAgentsEnabled({
              category: result.data.category,
              source: result.data.source,
              enabled: result.data.enabled,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR:
          runAsync(postCustomAgentDir());
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR:
          runAsync(setCustomAgentDir());
          return true;
        case SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR:
          runAsync(resetCustomAgentDir());
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS:
          postAgentModePresets();
          return true;
        case SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET:
          runAsync(applyAgentModePreset(result.data.presetId));
          return true;
        case SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET:
          runAsync(saveAgentModePreset());
          return true;
        case SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET:
          runAsync(deleteAgentModePreset(result.data.presetId));
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS:
          postGitAuthorSettings();
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS:
          runAsync(postLatexSettingsStatus());
          return true;
        case SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS:
          runAsync(postLatexSettingsStatus());
          return true;
        case SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP:
          runAsync(
            options.installToolExtension?.(LATEX_WORKSHOP_EXT_ID) ??
              Promise.resolve(),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND:
          runAsync(
            options.runInstallCommand?.(result.data.installCommand) ??
              Promise.resolve(),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES:
          postLatexConfigValues();
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE:
          runAsync(
            updateLatexConfigValue({
              field: result.data.field,
              value: result.data.value,
            }),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_MARK_COMMITS,
              result.data.enabled,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_AUTHOR_NAME,
              result.data.name,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_AUTHOR_EMAIL,
              result.data.email,
            ),
          );
          return true;
        case SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT:
          runAsync(
            updateGitAuthorSetting(
              WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
              result.data.enabled,
            ),
          );
          return true;
        default:
          return false;
      }
    },
  };
}
