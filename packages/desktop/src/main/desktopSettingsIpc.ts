import { platform } from '@platform/platform';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
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
import { FREE_TIER, MAX_TIER, ULTRA_TIER } from '@auth/sharedConfig';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import {
  DEFAULT_MODELS,
  buildBasicModelOptionsData,
} from '@model/modelOptionsBasic';
import type { LatexConfigField } from '@shared/constants/latex';
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import {
  SettingsViewInboundMessageSchema,
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
import type { ConfigProvider } from '@platform/interfaces/config';
import type { StateStore } from '@platform/interfaces/state';
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
  runToolCommand?: (input: {
    toolId: string;
    command: string;
    kind: 'install' | 'auth';
  }) => Promise<void>;
  onError?: (error: unknown) => void;
}

export type DesktopSettingsIpc = DesktopMessageHandler;

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
  const getCustomAgentDirectory =
    options.getCustomAgentDirectory ?? (() => getAgentDirectories().custom());
  const latexConfigPersistenceController =
    new LatexConfigPersistenceController();
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

  function postProfileData(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: false,
      user: null,
      tier: FREE_TIER,
      permissions: [],
      remoteAgents: [],
      apiAccessMode: 'personal',
      allowedModels: [],
      tierConstants: { ultra: ULTRA_TIER, max: MAX_TIER },
      providerKeyStatuses: [],
      globalStreamingDefault: true,
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
    postProfileData();
    postModelSelectionData();
    postApprovalSettings();
    await Promise.all([
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

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  applyCurrentGitAuthorSettings();

  return {
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
        case SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS:
          postGitAuthorSettings();
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
