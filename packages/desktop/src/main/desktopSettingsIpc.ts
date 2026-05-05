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
  onError?: (error: unknown) => void;
}

export type DesktopSettingsIpc = DesktopMessageHandler;

export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): DesktopSettingsIpc {
  const workspaceState = options.workspaceState ?? platform().workspaceState;
  const globalState = options.globalState ?? workspaceState;
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

  function getEnabledAgentNames(category: 'workflow' | 'toolUse'): Set<string> {
    const stateKey =
      category === 'workflow'
        ? WorkspaceStateKey.ENABLED_AGENTS
        : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;
    const defaultKeys = getAgents(category).map((entry) =>
      agentKey(entry.source, entry.name),
    );
    return new Set(
      (workspaceState.get<string[]>(stateKey, defaultKeys) ?? defaultKeys).map(
        agentName,
      ),
    );
  }

  function toAgentSelectionItem(
    entry: AgentEntry,
    enabledNames: Set<string>,
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
      enabled: enabledNames.has(entry.name),
    };
  }

  async function postAgentSelectionData(): Promise<void> {
    await loadAgents();
    const workflowEnabled = getEnabledAgentNames('workflow');
    const toolUseEnabled = getEnabledAgentNames('toolUse');
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
    options.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: await getAgentDirectories().custom(),
      isDefault: true,
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
        case SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR:
          runAsync(postCustomAgentDir());
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
