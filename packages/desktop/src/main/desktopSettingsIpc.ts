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
} from '@shared/schemas/settingsViewMessages';
import {
  applyGitAuthorSettings,
  readGitAuthorSettingsFromState,
} from '@utils/system/gitAuthorSettings';
import type { StateStore } from '@platform/interfaces/state';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopSettingsIpcOptions {
  postToRenderer(message: unknown): void;
  sendStartupCatalogData?: boolean;
  loadAgents?: typeof loadAgents;
  loadAgentOptionsData?: typeof computeAgentOptionsData;
  globalState?: StateStore;
  workspaceState?: StateStore;
  selectCustomAgentDirectory?: () => Promise<string | undefined>;
  onError?: (error: unknown) => void;
}

export type DesktopSettingsIpc = DesktopMessageHandler;

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
      getCustomDir: () => getAgentDirectories().custom(),
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
        return directories.custom();
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

  async function postInitialSettingsData(): Promise<void> {
    postGitAuthorSettings();
    postLatexConfigValues();
    postProfileData();
    postModelSelectionData();
    await Promise.all([postAgentSelectionData(), postCustomAgentDir()]);
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
