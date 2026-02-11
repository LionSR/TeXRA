/**
 * Schema-driven message handler for SettingsView.
 *
 * Combines handlers from MemoryView, HistoryView, and ProfileView
 * into a single unified message handler.
 */
import * as vscode from 'vscode';
import { MODELS, MODEL_CONFIGS } from 'llm-zoo';

// Shared schemas and dispatchers
import {
  dispatchSettingsViewInbound,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
  SETTINGS_VIEW_CMD,
  type ModelSelectionItem,
  type AgentSelectionItem,
} from '@shared/schemas/settingsViewMessages';
import {
  PROVIDER_DISPLAY_NAMES,
  MODEL_PROVIDERS_ORDER,
  DEFAULT_POLISH_MODEL,
} from '@shared/constants/providers';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ULTRA_TIER, MAX_TIER } from '@auth/config';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  type AgentEntry,
  createKey,
  getAgent,
  getAgentsBySource,
  getWorkflowAgents,
  getToolUseAgents,
  loadAgents,
} from '@agent/index';
import { selectAgentInMainView } from '@agent/remote/remoteAgentUtils';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import {
  BaseViewMessageHandler,
  SETTINGS_VIEW_COMMANDS,
} from '@common/webview';
import { showLoggedErrorMessage } from '@common/errors';
import {
  AgentHistoryManager,
  type AgentHistoryItem,
} from '@common/history/AgentHistoryManager';
import {
  GlobalStateKey,
  WorkspaceStateKey,
  globalSM,
  workspaceSM,
} from '@common/state';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import {
  DEFAULT_MODELS,
  formatContext,
  formatCost,
} from '@model/computeModelOptions';
import { MEMORY_STORAGE_ROOT } from '@tools/memory/constants';
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';
import { agentConfigToTaskState } from '@utils/config/configConversion';
import {
  getToolUseMemoryEnabled,
  setToolUseMemoryEnabled,
  getGlobalStreaming,
  setGlobalStreaming,
  getProviderStreaming,
  setProviderStreaming,
  getProviderEndpoint,
  setProviderEndpoint,
  supportsCustomEndpoint,
} from '@utils/config/constants';
import { getConfig } from '@utils/config/configUtils';
import { PROVIDER_URLS } from '@commands/api/apiKeyCommands';
import {
  _disableAllProposalBypasses,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import { loadMemoryItems } from './utils/memoryFileSystem';
import type {
  RemoteAgent,
  ProviderKeyStatus,
  ProviderVscodeSetting,
  NumberVscodeSetting,
} from '@shared/schemas/profileViewMessages';

// Type helper for extracting specific message types
type MessageFor<C extends SettingsViewInboundMessage['command']> = Extract<
  SettingsViewInboundMessage,
  { command: C }
>;

/** VS Code config settings to surface per provider in the Models tab. */
const PROVIDER_VSCODE_SETTINGS: Record<
  string,
  Omit<ProviderVscodeSetting, 'value'>[]
> = {
  openai: [
    {
      key: 'texra.model.gpt5ReasoningSummary',
      label: 'GPT-5 Reasoning Summary',
      description:
        'Request reasoning summaries from GPT-5 models. Only available on OpenAI API Tier 3+.',
      warning:
        'New accounts with $20 credit are typically Tier 1 and will hit rate limits.',
      warningUrl:
        'https://platform.openai.com/settings/organization/billing/overview',
      warningUrlLabel: 'Check your tier',
    },
    {
      key: 'texra.model.useOpenAIResponsesAPI',
      label: 'Use Responses API',
      description:
        'Use the OpenAI Responses API instead of Chat Completions when available.',
    },
    {
      key: 'texra.model.useBackgroundResponses',
      label: 'Background Responses',
      description:
        'Handle long-running generations (>10 min) via polling to prevent timeouts. Adds polling overhead.',
    },
  ],
  anthropic: [
    {
      key: 'texra.model.useAnthropic1MBeta',
      label: '1M Context Window Beta',
      description:
        'Enable the 1M-token context window for Claude Opus 4.6 and Sonnet 4 (usage capped at 200K by extension).',
    },
  ],
};

/** Reliability settings surfaced in the Multi-Agent tab. */
const RELIABILITY_SETTINGS: (Omit<NumberVscodeSetting, 'value'> & {
  defaultValue: number;
})[] = [
  {
    key: 'texra.model.compactionThresholdPercent',
    label: 'Compaction threshold',
    description:
      'Context window percentage to trigger automatic context compaction. Set to 0 to disable.',
    min: 0,
    max: 100,
    unit: '%',
    defaultValue: 75,
  },
  {
    key: 'texra.model.retry.maxAttempts',
    label: 'Retry attempts',
    description:
      'Automatic retry attempts before showing a manual retry button. Set to 0 for manual-only.',
    min: 0,
    defaultValue: 0,
  },
  {
    key: 'texra.model.retry.backoffMs',
    label: 'Retry backoff',
    description: 'Base delay between retry attempts.',
    min: 0,
    unit: 'ms',
    defaultValue: 1000,
  },
];

/** Allowed setting keys that the frontend can toggle (whitelist for safety). */
const ALLOWED_VSCODE_SETTING_KEYS = new Set([
  ...Object.values(PROVIDER_VSCODE_SETTINGS)
    .flat()
    .map((s) => s.key),
  ...RELIABILITY_SETTINGS.map((s) => s.key),
]);

function getProviderVscodeSettings(provider: string): ProviderVscodeSetting[] {
  const defs = PROVIDER_VSCODE_SETTINGS[provider.toLowerCase()];
  if (!defs) return [];
  // getConfig reads from VS Code's config API which already knows package.json defaults
  return defs.map((def) => ({
    ...def,
    value: getConfig<boolean>(def.key, false),
  }));
}

function getReliabilitySettings(): NumberVscodeSetting[] {
  return RELIABILITY_SETTINGS.map(({ defaultValue, ...def }) => ({
    ...def,
    value: getConfig<number>(def.key, defaultValue),
  }));
}

async function getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
  return Promise.all(
    SecretManager.API_PROVIDERS.map(async (provider) => {
      const secretValue = await SecretManager.get(
        SecretManager.getApiKeySecretName(provider),
      );
      const envValue = process.env[`${provider.toUpperCase()}_API_KEY`];
      const status: ProviderKeyStatus['status'] = secretValue
        ? 'set'
        : envValue
          ? 'env'
          : 'not-set';

      return {
        provider,
        displayName: PROVIDER_DISPLAY_NAMES[provider],
        status,
        keyUrl: PROVIDER_URLS[provider],
        streaming: getProviderStreaming(provider),
        customEndpoint: getProviderEndpoint(provider),
        supportsCustomEndpoint: supportsCustomEndpoint(provider),
        vscodeSettings: getProviderVscodeSettings(provider),
      };
    }),
  );
}

const modelProvidersSet = new Set<string>(MODEL_PROVIDERS_ORDER);

function buildModelSelectionItems(): ModelSelectionItem[] {
  const enabledSet = new Set(
    globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS),
  );

  const items: ModelSelectionItem[] = [];
  for (const name of MODELS) {
    const config = MODEL_CONFIGS[name];
    if (!config || !modelProvidersSet.has(config.provider)) continue;

    items.push({
      name,
      provider: config.provider,
      enabled: enabledSet.has(name),
      deprecated: config.deprecated ?? false,
      contextWindow: formatContext(config.contextWindow),
      cost: formatCost(config.inputPrice, config.outputPrice),
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function entryToSelectionItem(
  entry: AgentEntry,
  enabledKeys: string[] | undefined,
): AgentSelectionItem {
  const key = createKey(entry.source, entry.name);
  // undefined = never configured → all enabled; [] = explicitly empty → none enabled
  const enabled =
    enabledKeys === undefined ||
    enabledKeys.includes(key) ||
    enabledKeys.includes(entry.name);
  return {
    name: entry.name,
    source: entry.source,
    category: entry.category,
    description: entry.description,
    hasPath: Boolean(entry.path),
    tools: entry.tools,
    hasMultiple: entry.isMultiple ?? Boolean(entry.multiplePath),
    hasMultiplePath: Boolean(entry.multiplePath),
    enabled,
  };
}

function buildAgentSelectionItems(): {
  workflow: AgentSelectionItem[];
  toolUse: AgentSelectionItem[];
} {
  // No default → undefined means "never configured" (all enabled)
  const workflowEnabled = workspaceSM.get<string[]>(
    WorkspaceStateKey.ENABLED_AGENTS,
  );
  const toolUseEnabled = workspaceSM.get<string[]>(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  );

  const workflow = getWorkflowAgents()
    .map((e) => entryToSelectionItem(e, workflowEnabled))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toolUse = getToolUseAgents()
    .map((e) => entryToSelectionItem(e, toolUseEnabled))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { workflow, toolUse };
}

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  constructor(_context: vscode.ExtensionContext) {
    super('SettingsView', { trackActiveView: true });
    this.handlerRegistry = this.createHandlerRegistry();
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    return {
      // Navigation handlers
      [SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS]: () =>
        this.handleOpenVscodeSettings(),

      // Memory handlers
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA]: () =>
        this.handleGetMemoryData(),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE]: (data) =>
        this.handleOpenMemoryFile(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]: () =>
        this.handleOpenMemoryFolder(),
      [SETTINGS_VIEW_COMMANDS.DELETE_MEMORY]: (data) =>
        this.handleDeleteMemory(data),
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED]: () =>
        this.handleGetMemoryEnabled(),
      [SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED]: (data) =>
        this.handleSetMemoryEnabled(data),

      // History handlers
      [SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA]: () =>
        this.handleGetHistoryData(),
      [SETTINGS_VIEW_COMMANDS.RERUN_AGENT]: (data) =>
        this.handleRerunAgent(data),
      [SETTINGS_VIEW_COMMANDS.RESTORE_AGENT]: (data) =>
        this.handleRestoreAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT]: (data) =>
        this.handleDeleteAgent(data),
      [SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY]: () => this.handleClearHistory(),

      // Profile handlers
      [SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA]: () =>
        this.handleGetProfileData(),
      [SETTINGS_VIEW_COMMANDS.SELECT_AGENT]: (data) =>
        this.handleSelectAgent(data),
      [SETTINGS_VIEW_COMMANDS.SIGN_IN]: () => this.handleSignIn(),
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT]: () => this.handleSignOut(),
      [SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE]: (data) =>
        this.handleSetApiAccessMode(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY]: (data) =>
        this.handleSetProviderKey(data),
      [SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY]: (data) =>
        this.handleRemoveProviderKey(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL]: (data) =>
        this.handleOpenProviderKeyUrl(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_STREAMING]: (data) =>
        this.handleSetProviderStreaming(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_ENDPOINT]: (data) =>
        this.handleSetProviderEndpoint(data),
      [SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING]: (data) =>
        this.handleSetGlobalStreaming(data),
      [SETTINGS_VIEW_COMMANDS.SET_PROVIDER_VSCODE_SETTING]: (data) =>
        this.handleSetProviderVscodeSetting(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL]: (data) =>
        this.handleOpenExternalUrl(data),

      // Model selection handlers
      [SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION]: () =>
        this.handleGetModelSelection(),
      [SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED]: (data) =>
        this.handleSetModelEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_POLISH_MODEL]: (data) =>
        this.handleSetPolishModel(data),

      // Auto-show remote agents handlers
      [SETTINGS_VIEW_COMMANDS.GET_AUTO_SHOW_REMOTE]: () =>
        this.handleGetAutoShowRemote(),
      [SETTINGS_VIEW_COMMANDS.SET_AUTO_SHOW_REMOTE]: (data) =>
        this.handleSetAutoShowRemote(data),

      // Custom agent directory handlers
      [SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR]: () =>
        this.handleGetCustomAgentDir(),
      [SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR]: () =>
        this.handleSetCustomAgentDir(),
      [SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR]: () =>
        this.handleResetCustomAgentDir(),

      // Super YOLO handlers
      [SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED]: () =>
        this.handleGetSuperYoloEnabled(),
      [SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED]: (data) =>
        this.handleSetSuperYoloEnabled(data),

      // Agent selection handlers
      [SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION]: () =>
        this.handleGetAgentSelection(),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML]: (data) =>
        this.handleOpenAgentYaml(data),
      [SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED]: (data) =>
        this.handleSetAgentEnabled(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER]: (data) =>
        this.handleOpenAgentFolder(data),
      [SETTINGS_VIEW_COMMANDS.CREATE_AGENT]: (data) =>
        this.handleCreateAgent(data),
    };
  }

  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withActiveView(webviewView, async () => {
      const handled = dispatchSettingsViewInbound(
        message,
        this.handlerRegistry,
        (error) => {
          this.logger.debug(this.channel, 'Message validation failed', {
            data: error,
          });
        },
      );

      if (
        !handled &&
        message &&
        typeof message === 'object' &&
        'command' in message
      ) {
        this.logger.warn(
          this.channel,
          `Unhandled command: ${(message as { command: string }).command}`,
        );
      }
    });
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Run a callback with the active view's webview, if available. */
  private async withActiveWebview(
    fn: (webview: vscode.Webview) => Promise<void>,
  ): Promise<void> {
    const view = this.getActiveView();
    if (view) await fn(view.webview);
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendAllData(webview: vscode.Webview): Promise<void> {
    await Promise.all([
      this.sendMemoryData(webview),
      this.sendMemoryEnabled(webview),
      this.sendHistoryData(webview),
      this.sendProfileData(webview),
      this.sendModelSelectionData(webview),
      this.sendAgentSelectionData(webview),
      this.sendAutoShowRemote(webview),
      this.sendCustomAgentDir(webview),
      this.sendSuperYoloEnabled(webview),
    ]);
  }

  public async sendMemoryData(webview: vscode.Webview): Promise<void> {
    const items = await loadMemoryItems();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    });
  }

  public async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    const enabled = getToolUseMemoryEnabled();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled,
    });
  }

  public async sendHistoryData(webview: vscode.Webview): Promise<void> {
    const history = await AgentHistoryManager.getHistory();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems: history,
    });
  }

  public async sendProfileData(webview: vscode.Webview): Promise<void> {
    const isAuthenticated = await SupabaseClient.isAuthenticated();
    const providerKeyStatuses = await getProviderKeyStatuses();

    const globalStreamingDefault = getGlobalStreaming();

    if (!isAuthenticated) {
      await webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
        authenticated: false,
        user: null,
        tier: 'free',
        permissions: [],
        remoteAgents: [],
        apiAccessMode: 'personal',
        allowedModels: [],
        tierConstants: {
          ultra: ULTRA_TIER,
          max: MAX_TIER,
        },
        providerKeyStatuses,
        globalStreamingDefault,
      });
      return;
    }

    const serverSideKeyService = getServerSideKeyService();
    const hasServerSideAccess =
      await serverSideKeyService.canUseServerSideKeys();

    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();

    await loadAgents();
    const remoteAgents: RemoteAgent[] = getAgentsBySource('remote').map(
      (entry) => ({
        name: entry.name,
        description: entry.description ?? '',
        visibility: entry.visibility ?? ['public'],
        category: entry.category,
        supportsMultipleOutput: entry.isMultiple ?? false,
      }),
    );

    const useIncludedAccess = serverSideKeyService.getUseIncludedModelAccess();
    const apiAccessMode = useIncludedAccess ? 'included' : 'personal';

    const allowedModels = hasServerSideAccess
      ? serverSideKeyService.getAllowedModelsForCurrentUser()
      : [];

    const accessExpiresAt = serverSideKeyService.getAccessExpirationDate();

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      authenticated: true,
      user: {
        email: user?.email ?? 'N/A',
        id: user?.id ?? '',
      },
      tier: authContext.tier,
      permissions: authContext.permissions,
      remoteAgents,
      apiAccessMode,
      allowedModels,
      tierConstants: {
        ultra: ULTRA_TIER,
        max: MAX_TIER,
      },
      accessExpiresAt: accessExpiresAt?.toISOString() ?? null,
      providerKeyStatuses,
      globalStreamingDefault,
    });
  }

  public async sendModelSelectionData(webview: vscode.Webview): Promise<void> {
    const models = buildModelSelectionItems();
    const polishModel = globalSM.get<string>(
      GlobalStateKey.POLISH_MODEL,
      DEFAULT_POLISH_MODEL,
    );
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      models,
      polishModel,
    });
  }

  public async sendAgentSelectionData(webview: vscode.Webview): Promise<void> {
    await loadAgents();
    const { workflow, toolUse } = buildAgentSelectionItems();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      workflow,
      toolUse,
    });
  }

  public async sendCustomAgentDir(webview: vscode.Webview): Promise<void> {
    const configuredPath = (
      globalSM.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, '') ?? ''
    ).trim();
    const isDefault = configuredPath === '';
    const resolvedPath = await agentDirectories.custom();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: resolvedPath,
      isDefault,
    });
  }

  // ============================================================
  // Auto-show remote agents handler implementations
  // ============================================================

  public async sendAutoShowRemote(webview: vscode.Webview): Promise<void> {
    const enabled =
      globalSM.get<boolean>(GlobalStateKey.AUTO_SHOW_REMOTE_AGENTS, true) ??
      true;
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AUTO_SHOW_REMOTE,
      enabled,
    });
  }

  private async handleGetAutoShowRemote(): Promise<void> {
    await this.withActiveWebview((w) => this.sendAutoShowRemote(w));
  }

  private async handleSetAutoShowRemote(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_AUTO_SHOW_REMOTE>,
  ): Promise<void> {
    await globalSM.update(GlobalStateKey.AUTO_SHOW_REMOTE_AGENTS, data.enabled);
    void vscode.commands.executeCommand('texra.refreshAllOptions');
    await this.withActiveWebview((w) => this.sendAutoShowRemote(w));
  }

  // ============================================================
  // Super YOLO handler implementations
  // ============================================================

  public async sendSuperYoloEnabled(webview: vscode.Webview): Promise<void> {
    const enabled =
      workspaceSM.get<boolean>(WorkspaceStateKey.SUPER_YOLO_ENABLED, false) ??
      false;
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
      enabled,
      reliabilitySettings: getReliabilitySettings(),
    });
  }

  private async handleGetSuperYoloEnabled(): Promise<void> {
    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
  }

  private async handleSetSuperYoloEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_SUPER_YOLO_ENABLED>,
  ): Promise<void> {
    await workspaceSM.update(
      WorkspaceStateKey.SUPER_YOLO_ENABLED,
      data.enabled,
    );

    // Disabling the feature: clear all per-stream Super YOLO and YOLO bypasses
    if (!data.enabled) {
      const affected = _disableAllProposalBypasses();
      for (const streamId of affected) {
        setToolEditApprovalSessionBypass(streamId, false);
      }
    }

    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
    void vscode.window.showInformationMessage(
      `Super YOLO mode ${data.enabled ? 'enabled' : 'disabled'}`,
    );
  }

  // ============================================================
  // Navigation handler implementations
  // ============================================================

  private async handleOpenVscodeSettings(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:texra-ai.texra',
    );
  }

  // ============================================================
  // Memory handler implementations
  // ============================================================

  private async handleGetMemoryData(): Promise<void> {
    await this.withActiveWebview((w) => this.sendMemoryData(w));
  }

  private async handleOpenMemoryFile(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
      const doc = await vscode.workspace.openTextDocument(absolutePath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory file',
        error,
      );
    }
  }

  private async handleOpenMemoryFolder(): Promise<void> {
    try {
      await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
      const absolutePath = StorageFS.fullPath(MEMORY_STORAGE_ROOT);
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(absolutePath),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory folder',
        error,
      );
    }
  }

  private async handleDeleteMemory(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_MEMORY>,
  ): Promise<void> {
    const view = this.getActiveView();

    const confirm = await vscode.window.showWarningMessage(
      `Delete "${data.displayPath}"?`,
      { modal: true },
      'Delete',
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      await StorageFS.delete(resolvedPath, { recursive: true });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete memory',
        error,
      );
    } finally {
      if (view) {
        await this.sendMemoryData(view.webview);
      }
    }
  }

  private async handleGetMemoryEnabled(): Promise<void> {
    await this.withActiveWebview((w) => this.sendMemoryEnabled(w));
  }

  private async handleSetMemoryEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    await setToolUseMemoryEnabled(data.enabled);
    await this.withActiveWebview((w) => this.sendMemoryEnabled(w));
  }

  // ============================================================
  // History handler implementations
  // ============================================================

  private async handleGetHistoryData(): Promise<void> {
    await this.withActiveWebview((w) => this.sendHistoryData(w));
  }

  private async handleRerunAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RERUN_AGENT>,
  ): Promise<void> {
    await this.withHistoryItem(
      data.historyId,
      'Failed to rerun agent',
      async (historyItem) => {
        await vscode.window.showInformationMessage(
          'Rerunning agent from history',
        );
        await runExecuteCommand(historyItem.agentConfig);
      },
    );
  }

  private async handleRestoreAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RESTORE_AGENT>,
  ): Promise<void> {
    await this.withHistoryItem(
      data.historyId,
      'Failed to restore configuration',
      async (historyItem) => {
        const taskState = agentConfigToTaskState(historyItem.agentConfig);
        await vscode.commands.executeCommand('texra.restoreState', taskState);
      },
    );
  }

  private async handleDeleteAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT>,
  ): Promise<void> {
    const view = this.getActiveView();
    try {
      const deleted = await AgentHistoryManager.deleteHistoryItemById(
        data.historyId,
      );
      if (deleted && view) {
        await this.sendHistoryData(view.webview);
      } else if (!deleted) {
        await vscode.window.showWarningMessage(
          `History item not found: ${data.historyId}`,
        );
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete history item',
        error,
      );
    }
  }

  private async handleClearHistory(): Promise<void> {
    const view = this.getActiveView();
    try {
      await AgentHistoryManager.clearHistory();
      await vscode.window.showInformationMessage('Agent history cleared');
      await view?.webview.postMessage({
        command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
      });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to clear history',
        error,
      );
    }
  }

  private async withHistoryItem(
    historyId: string,
    errorPrefix: string,
    action: (historyItem: AgentHistoryItem) => Promise<void>,
  ): Promise<void> {
    try {
      const historyItem =
        await AgentHistoryManager.getHistoryItemById(historyId);
      if (!historyItem) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }
      await action(historyItem);
    } catch (error) {
      await showLoggedErrorMessage(this.channel, errorPrefix, error);
    }
  }

  // ============================================================
  // Profile handler implementations
  // ============================================================

  private async handleGetProfileData(): Promise<void> {
    await this.withActiveWebview((w) => this.sendProfileData(w));
  }

  private async handleSelectAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SELECT_AGENT>,
  ): Promise<void> {
    await selectAgentInMainView(data.agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: false,
    });
  }

  private async handleSignIn(): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
  }

  private async handleSignOut(): Promise<void> {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT);
  }

  private async handleSetApiAccessMode(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_API_ACCESS_MODE>,
  ): Promise<void> {
    const useIncludedAccess = data.mode === 'included';
    await getServerSideKeyService().setUseIncludedModelAccess(
      useIncludedAccess,
    );

    await this.withActiveWebview((w) => this.sendProfileData(w));

    const modeLabel =
      data.mode === 'included' ? 'Included Access' : 'My Own Keys';
    void vscode.window.showInformationMessage(
      `Model access changed to: ${modeLabel}`,
    );
  }

  private async handleSetProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_KEY>,
  ): Promise<void> {
    const provider = data.provider as ApiProvider;
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

    const apiKey = await vscode.window.showInputBox({
      prompt: `Enter ${displayName} API key`,
      password: true,
      placeHolder: '************************************',
    });

    if (!apiKey) {
      return;
    }

    try {
      await SecretManager.set(
        SecretManager.getApiKeySecretName(provider),
        apiKey,
      );
      void vscode.window.showInformationMessage(
        `${displayName} API key has been set`,
      );
      await this.refreshAfterKeyChange();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to set ${displayName} API key`,
        error,
      );
    } finally {
      await this.withActiveWebview((w) => this.sendProfileData(w));
    }
  }

  private async handleRemoveProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.REMOVE_PROVIDER_KEY>,
  ): Promise<void> {
    const provider = data.provider as ApiProvider;
    const displayName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

    try {
      await SecretManager.delete(SecretManager.getApiKeySecretName(provider));
      void vscode.window.showInformationMessage(
        `${displayName} API key has been removed`,
      );
      await this.refreshAfterKeyChange();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to remove ${displayName} API key`,
        error,
      );
    } finally {
      await this.withActiveWebview((w) => this.sendProfileData(w));
    }
  }

  /** Refresh main view API key status and model options after key changes. */
  private async refreshAfterKeyChange(): Promise<void> {
    await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
    void vscode.commands.executeCommand('texra.refreshAllOptions');
  }

  private async handleOpenProviderKeyUrl(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_PROVIDER_KEY_URL>,
  ): Promise<void> {
    const provider = data.provider as ApiProvider;
    const url = PROVIDER_URLS[provider];
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async handleSetProviderStreaming(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_STREAMING>,
  ): Promise<void> {
    await setProviderStreaming(data.provider, data.enabled);
    await this.withActiveWebview((w) => this.sendProfileData(w));
  }

  private async handleSetProviderEndpoint(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_ENDPOINT>,
  ): Promise<void> {
    await setProviderEndpoint(data.provider, data.endpoint);
    await this.withActiveWebview((w) => this.sendProfileData(w));
  }

  private async handleSetGlobalStreaming(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_GLOBAL_STREAMING>,
  ): Promise<void> {
    await setGlobalStreaming(data.enabled);
    await this.withActiveWebview((w) => this.sendProfileData(w));
  }

  private async handleOpenExternalUrl(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_EXTERNAL_URL>,
  ): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(data.url));
  }

  private async handleSetProviderVscodeSetting(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_VSCODE_SETTING>,
  ): Promise<void> {
    if (!ALLOWED_VSCODE_SETTING_KEYS.has(data.key)) {
      this.logger.warn(
        this.channel,
        `Rejected unknown vscode setting key: ${data.key}`,
      );
      return;
    }

    const config = vscode.workspace.getConfiguration();
    await config.update(
      data.key,
      data.value,
      vscode.ConfigurationTarget.Global,
    );

    await this.withActiveWebview(async (w) => {
      await Promise.all([
        this.sendProfileData(w),
        this.sendSuperYoloEnabled(w),
      ]);
    });
  }

  // ============================================================
  // Model selection handler implementations
  // ============================================================

  private async handleGetModelSelection(): Promise<void> {
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetModelEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MODEL_ENABLED>,
  ): Promise<void> {
    const current = globalSM.get<string[]>(
      GlobalStateKey.ENABLED_MODELS,
      DEFAULT_MODELS,
    );

    let updated: string[];
    if (data.enabled) {
      updated = current.includes(data.modelName)
        ? current
        : [...current, data.modelName];
    } else {
      updated = current.filter((m) => m !== data.modelName);
    }

    await globalSM.update(GlobalStateKey.ENABLED_MODELS, updated);

    // Auto-reset polish model if it was just disabled
    if (!data.enabled) {
      const polishModel = globalSM.get<string>(
        GlobalStateKey.POLISH_MODEL,
        DEFAULT_POLISH_MODEL,
      );
      if (polishModel === data.modelName) {
        const newPolish = updated[0] ?? DEFAULT_POLISH_MODEL;
        await globalSM.update(GlobalStateKey.POLISH_MODEL, newPolish);
      }
    }

    void vscode.commands.executeCommand('texra.refreshAllOptions');
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetPolishModel(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_POLISH_MODEL>,
  ): Promise<void> {
    await globalSM.update(GlobalStateKey.POLISH_MODEL, data.modelName);
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  // ============================================================
  // Agent selection handler implementations
  // ============================================================

  private async handleGetAgentSelection(): Promise<void> {
    await this.withActiveWebview((w) => this.sendAgentSelectionData(w));
  }

  private async handleOpenAgentYaml(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_YAML>,
  ): Promise<void> {
    try {
      const key = createKey(data.agentSource, data.agentName);
      const entry = getAgent(key);
      if (!entry) {
        await vscode.window.showErrorMessage(
          `Agent not found: ${data.agentName} (${data.agentSource})`,
        );
        return;
      }

      const agentPath =
        data.variant === 'multiple' ? entry.multiplePath : entry.path;
      if (!agentPath) {
        await vscode.window.showErrorMessage(
          `No ${data.variant} YAML path for agent: ${data.agentName}`,
        );
        return;
      }

      const doc = await vscode.workspace.openTextDocument(agentPath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open agent YAML file',
        error,
      );
    }
  }

  private async handleSetAgentEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_AGENT_ENABLED>,
  ): Promise<void> {
    try {
      const stateKey =
        data.category === 'workflow'
          ? WorkspaceStateKey.ENABLED_AGENTS
          : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;
      // No default → undefined means "never configured" (all enabled)
      const raw = workspaceSM.get<string[]>(stateKey);
      const current = raw ?? [];
      const key = createKey(data.agentSource, data.agentName);

      let updated: string[];
      if (data.enabled) {
        // Add by source:name key if not already present (check both formats)
        if (current.includes(key) || current.includes(data.agentName)) {
          updated = current;
        } else {
          updated = [...current, key];
        }
      } else if (raw === undefined) {
        // Never configured (undefined) = "all enabled". To disable one agent,
        // seed the config with all OTHER agents: undefined → [all except this one].
        const allAgents =
          data.category === 'workflow'
            ? getWorkflowAgents()
            : getToolUseAgents();
        updated = allAgents
          .map((e) => createKey(e.source, e.name))
          .filter((k) => k !== key);
      } else {
        // Remove both name and source:name formats.
        // An empty result means "nothing enabled" (not "all enabled").
        updated = current.filter(
          (entry) => entry !== key && entry !== data.agentName,
        );
      }

      await workspaceSM.update(stateKey, updated);

      void vscode.commands.executeCommand('texra.refreshAllOptions');
      await this.withActiveWebview((w) => this.sendAgentSelectionData(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to update agent visibility',
        error,
      );
    }
  }

  private async handleOpenAgentFolder(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_AGENT_FOLDER>,
  ): Promise<void> {
    try {
      const folderPath = await agentDirectories.getDirectory(data.folderType);
      if (!folderPath) {
        await vscode.window.showErrorMessage(
          `No local directory for agent source: ${data.folderType}`,
        );
        return;
      }
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(folderPath),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open agent folder',
        error,
      );
    }
  }

  private async handleCreateAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.CREATE_AGENT>,
  ): Promise<void> {
    await vscode.commands.executeCommand(
      'texra.createAgentWithAI',
      data.category,
    );

    await this.withActiveWebview((w) => this.sendAgentSelectionData(w));
  }

  // ============================================================
  // Custom agent directory handler implementations
  // ============================================================

  private async handleGetCustomAgentDir(): Promise<void> {
    await this.withActiveWebview((w) => this.sendCustomAgentDir(w));
  }

  /** Refresh agent dir + selection after a directory change. */
  private async refreshAgentDirUI(): Promise<void> {
    await agentDirectories.refreshAfterDirChange();
    await loadAgents();
    await this.withActiveWebview(async (w) => {
      await Promise.all([
        this.sendCustomAgentDir(w),
        this.sendAgentSelectionData(w),
      ]);
    });
    void vscode.commands.executeCommand('texra.refreshAllOptions');
  }

  private async handleSetCustomAgentDir(): Promise<void> {
    try {
      const selectedPath = await agentDirectories.promptCustom();
      if (!selectedPath) return;
      await this.refreshAgentDirUI();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to set custom agent directory',
        error,
      );
    }
  }

  private async handleResetCustomAgentDir(): Promise<void> {
    try {
      await globalSM.update(GlobalStateKey.CUSTOM_AGENT_DIR, '');
      await this.refreshAgentDirUI();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to reset custom agent directory',
        error,
      );
    }
  }
}
