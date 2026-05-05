import { platform } from '@platform/platform';
import { MODELS, MODEL_CONFIGS } from 'llm-zoo';

import { LatexConfigPersistenceController } from '@controllers/settingsView/LatexConfigPersistenceController';
import {
  getToolUseAgents,
  getWorkflowAgents,
  loadAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { getAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import {
  DEFAULT_MODELS,
  formatContext,
  formatCost,
} from '@model/modelOptionsBasic';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { isFastFirstResponseModel } from '@shared/constants/fastModels';
import type { LatexConfigField } from '@shared/constants/latex';
import { agentKey, agentName } from '@shared/schemas/agent';
import {
  SettingsViewInboundMessageSchema,
  type AgentSelectionItem,
  type ModelSelectionItem,
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
  const latexConfigPersistenceController =
    new LatexConfigPersistenceController();

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

  function getAgents(category: 'workflow' | 'toolUse'): AgentEntry[] {
    return category === 'workflow' ? getWorkflowAgents() : getToolUseAgents();
  }

  function getAgentStateKey(
    category: 'workflow' | 'toolUse',
  ): WorkspaceStateKey {
    return category === 'workflow'
      ? WorkspaceStateKey.ENABLED_AGENTS
      : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;
  }

  function getDefaultAgentKeys(category: 'workflow' | 'toolUse'): string[] {
    return getAgents(category).map((entry) =>
      agentKey(entry.source, entry.name),
    );
  }

  function getEnabledAgentKeys(category: 'workflow' | 'toolUse'): Set<string> {
    const stateKey = getAgentStateKey(category);
    const defaultKeys = getDefaultAgentKeys(category);
    return new Set(
      workspaceState.get<string[]>(stateKey, defaultKeys) ?? defaultKeys,
    );
  }

  function toAgentSelectionItem(
    entry: AgentEntry,
    enabledKeys: Set<string>,
  ): AgentSelectionItem {
    return {
      name: entry.name,
      category: entry.category,
      description: entry.description,
      source: entry.source,
      hasPath: Boolean(entry.path),
      filePath: entry.path || undefined,
      tools: entry.tools,
      hasMultiple: entry.isMultiple ?? Boolean(entry.multiplePath),
      hasMultiplePath: Boolean(entry.multiplePath),
      enabled:
        enabledKeys.has(agentKey(entry.source, entry.name)) ||
        enabledKeys.has(agentName(entry.name)),
    };
  }

  async function postAgentSelectionData(): Promise<void> {
    await loadAgents();
    const workflowEnabled = getEnabledAgentKeys('workflow');
    const toolUseEnabled = getEnabledAgentKeys('toolUse');
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      workflow: getWorkflowAgents().map((entry) =>
        toAgentSelectionItem(entry, workflowEnabled),
      ),
      toolUse: getToolUseAgents().map((entry) =>
        toAgentSelectionItem(entry, toolUseEnabled),
      ),
    });
  }

  function buildModelSelectionItems(): ModelSelectionItem[] {
    const enabledSet = new Set(
      globalState.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS),
    );
    return MODELS.flatMap((name): ModelSelectionItem[] => {
      const config = MODEL_CONFIGS[name];
      if (!config) return [];
      return [
        {
          name,
          label: config.label,
          provider: config.provider,
          enabled: enabledSet.has(name),
          deprecated: config.deprecated ?? false,
          contextWindow: formatContext(config.contextWindow),
          cost: formatCost(config.inputPrice, config.outputPrice),
          isFast: isFastFirstResponseModel(config.inputPrice),
        },
      ];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function postModelSelectionData(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      models: buildModelSelectionItems(),
      helperModel: globalState.get<string>(
        GlobalStateKey.HELPER_MODEL,
        DEFAULT_HELPER_MODEL,
      ),
      preferShortModelNames: globalState.get<boolean>(
        GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
        false,
      ),
    });
  }

  async function postCustomAgentDir(): Promise<void> {
    const configuredPath = globalState
      .get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, '')
      .trim();
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: await getAgentDirectories().custom(),
      isDefault: configuredPath.length === 0,
    });
  }

  function postProfileData(): void {
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: false,
      user: null,
      tier: 'free',
      permissions: [],
      remoteAgents: [],
      apiAccessMode: 'personal',
      allowedModels: [],
      tierConstants: { ultra: 'ultra', max: 'max' },
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
    const current = globalState.get<string[]>(
      GlobalStateKey.ENABLED_MODELS,
      DEFAULT_MODELS,
    );
    const updated = input.enabled
      ? current.includes(input.modelName)
        ? current
        : [...current, input.modelName]
      : current.filter((modelName) => modelName !== input.modelName);
    const wasHelper =
      !input.enabled &&
      globalState.get<string>(
        GlobalStateKey.HELPER_MODEL,
        DEFAULT_HELPER_MODEL,
      ) === input.modelName;

    await globalState.update(GlobalStateKey.ENABLED_MODELS, updated);
    if (wasHelper) {
      await globalState.update(
        GlobalStateKey.HELPER_MODEL,
        updated[0] ?? DEFAULT_HELPER_MODEL,
      );
    }
    postModelSelectionData();
  }

  async function updateModelReasoningLevel(input: {
    modelName: string;
    level: string | null;
  }): Promise<void> {
    const overrides = {
      ...globalState.get<Record<string, string>>(
        GlobalStateKey.REASONING_LEVELS,
        {},
      ),
    };
    if (input.level == null) {
      delete overrides[input.modelName];
    } else {
      overrides[input.modelName] = input.level;
    }
    await globalState.update(GlobalStateKey.REASONING_LEVELS, overrides);
    postModelSelectionData();
  }

  async function updateAgentEnabled(input: {
    category: 'workflow' | 'toolUse';
    source: string;
    name: string;
    enabled: boolean;
  }): Promise<void> {
    const stateKey = getAgentStateKey(input.category);
    const defaultKeys = getDefaultAgentKeys(input.category);
    const current = workspaceState.get<string[]>(stateKey, defaultKeys) ?? [];
    const currentSet = new Set(current);
    const targetKey = agentKey(input.source, input.name);
    if (input.enabled) {
      currentSet.add(targetKey);
    } else {
      currentSet.delete(targetKey);
    }
    await workspaceState.update(stateKey, [...currentSet]);
    await postAgentSelectionData();
  }

  async function updateAllAgentsEnabled(input: {
    category: 'workflow' | 'toolUse';
    source: string;
    enabled: boolean;
  }): Promise<void> {
    const stateKey = getAgentStateKey(input.category);
    const defaultKeys = getDefaultAgentKeys(input.category);
    const current = workspaceState.get<string[]>(stateKey, defaultKeys) ?? [];
    const currentSet = new Set(current);
    const sourceKeys = getAgents(input.category)
      .filter((entry) => entry.source === input.source)
      .map((entry) => agentKey(entry.source, entry.name));
    for (const key of sourceKeys) {
      if (input.enabled) {
        currentSet.add(key);
      } else {
        currentSet.delete(key);
      }
    }
    await workspaceState.update(stateKey, [...currentSet]);
    await postAgentSelectionData();
  }

  async function setCustomAgentDir(): Promise<void> {
    const selectedPath = await options.selectCustomAgentDirectory?.();
    if (!selectedPath) return;

    await globalState.update(GlobalStateKey.CUSTOM_AGENT_DIR, selectedPath);
    await Promise.all([postCustomAgentDir(), postAgentSelectionData()]);
  }

  async function resetCustomAgentDir(): Promise<void> {
    await globalState.update(GlobalStateKey.CUSTOM_AGENT_DIR, undefined);
    await Promise.all([postCustomAgentDir(), postAgentSelectionData()]);
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
          runAsync(
            Promise.resolve(
              globalState.update(
                GlobalStateKey.HELPER_MODEL,
                result.data.modelName,
              ),
            ).then(() => postModelSelectionData()),
          );
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
          runAsync(
            Promise.resolve(
              globalState.update(
                GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
                result.data.enabled,
              ),
            ).then(() => postModelSelectionData()),
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
