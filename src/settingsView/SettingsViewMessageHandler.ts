/**
 * Schema-driven message handler for SettingsView.
 *
 * Combines handlers from MemoryView, HistoryView, and ProfileView
 * into a single unified message handler.
 */
import * as path from 'path';
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
  type LatexSettingsStatus,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import {
  PROVIDER_DISPLAY_NAMES,
  MODEL_PROVIDERS_ORDER,
  DEFAULT_HELPER_MODEL,
} from '@shared/constants/providers';
import {
  LATEX_WORKSHOP_EXT_ID,
  normalizePlatform,
  DEPENDENCY_INSTALL_COMMANDS,
  HOMEBREW_INSTALL_COMMAND,
  SCOOP_INSTALL_COMMAND,
} from '@shared/constants/latex';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ULTRA_TIER, MAX_TIER } from '@auth/config';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  type AgentEntry,
  createKey,
  deduplicateByName,
  getAgent,
  getAgentsBySource,
  getVisibleAgents,
  getWorkflowAgents,
  getToolUseAgents,
  loadAgents,
} from '@agent/index';
import {
  getExecutionStore,
  listExecutions,
  deleteExecution,
  deleteAllExecutions,
} from '@agent/storage';
import { selectAgentInMainView } from '@agent/remote/remoteAgentUtils';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { getActiveExecutionIds } from '@agent/runtime/executionRegistry';
import { getHelperModelName } from '@agent/runtime/helperModel';
import {
  BaseViewMessageHandler,
  SETTINGS_VIEW_COMMANDS,
} from '@common/webview';
import { showLoggedErrorMessage } from '@common/errors';
import {
  GlobalStateKey,
  WorkspaceStateKey,
  globalSM,
  workspaceSM,
} from '@common/state';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import {
  DEFAULT_MODELS,
  formatContext,
  formatCost,
} from '@model/computeModelOptions';
import {
  _disableAllProposalBypasses,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { MEMORY_STORAGE_ROOT } from '@tools/memory/constants';
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import { AbsoluteFS, StorageFS } from '@utils/files';
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
import {
  getConfig,
  isConfigExplicitlySet,
  updateConfig,
} from '@utils/config/configUtils';
import {
  checkToolInstalled,
  detectPackageManager,
} from '@utils/system/toolUtils';
import { findToolInCommonPaths } from '@utils/system/platformPaths';
import { PROVIDER_URLS } from '@commands/api/apiKeyCommands';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import {
  AGENT_MODE_PRESETS,
  AgentModePresetSchema,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { z } from 'zod';
import { loadMemoryItems } from './utils/memoryFileSystem';
import { buildToolDashboardItems } from './utils/toolDashboardData';
import type {
  RemoteAgent,
  ProviderKeyStatus,
  ProviderVscodeSetting,
  NumberVscodeSetting,
} from '@shared/schemas/profileViewMessages';
import type { ExecutionId } from '@shared/schemas';

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
        'Enable the 1M-token context window for Claude Opus 4.6, Sonnet 4.6, and Sonnet 4 (usage capped at 200K by extension).',
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

      let status: ProviderKeyStatus['status'];
      if (secretValue) {
        status = 'set';
      } else if (envValue) {
        status = 'env';
      } else {
        status = 'not-set';
      }

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
    filePath: entry.path || undefined,
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

/** How long cached LaTeX settings remain valid (ms). */
const LATEX_SETTINGS_CACHE_TTL = 60_000;

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  /** Cached LaTeX settings to avoid redundant tool detection on repeat opens. */
  private latexSettingsCache: {
    settings: LatexSettingsStatus;
    timestamp: number;
  } | null = null;

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
        this.withActiveWebview((w) => this.sendMemoryData(w)),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE]: (data) =>
        this.handleOpenMemoryFile(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]: () =>
        this.handleOpenMemoryFolder(),
      [SETTINGS_VIEW_COMMANDS.DELETE_MEMORY]: (data) =>
        this.handleDeleteMemory(data),
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendMemoryEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED]: (data) =>
        this.handleSetMemoryEnabled(data),

      // History handlers
      [SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA]: () =>
        this.withActiveWebview((w) => this.sendHistoryData(w)),
      [SETTINGS_VIEW_COMMANDS.RERUN_AGENT]: (data) =>
        this.handleRerunAgent(data),
      [SETTINGS_VIEW_COMMANDS.RESTORE_AGENT]: (data) =>
        this.handleRestoreAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT]: (data) =>
        this.handleDeleteAgent(data),
      [SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY]: () => this.handleClearHistory(),

      // Profile handlers
      [SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA]: () =>
        this.withActiveWebview((w) => this.sendProfileData(w)),
      [SETTINGS_VIEW_COMMANDS.SELECT_AGENT]: (data) =>
        this.handleSelectAgent(data),
      [SETTINGS_VIEW_COMMANDS.SIGN_IN]: async () =>
        vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN),
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT]: async () =>
        vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_OUT),
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
        this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      [SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED]: (data) =>
        this.handleSetModelEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL]: (data) =>
        this.handleSetHelperModel(data),

      // Custom agent directory handlers
      [SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR]: () =>
        this.withActiveWebview((w) => this.sendCustomAgentDir(w)),
      [SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR]: () =>
        this.handleSetCustomAgentDir(),
      [SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR]: () =>
        this.handleResetCustomAgentDir(),

      // Super YOLO handlers
      [SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED]: (data) =>
        this.handleSetSuperYoloEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL]: (data) =>
        this.handleSetAllowOrchestratorKill(data),

      // Agent selection handlers
      [SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION]: () =>
        this.withActiveWebview((w) => this.sendAgentSelectionData(w)),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML]: (data) =>
        this.handleOpenAgentYaml(data),
      [SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED]: (data) =>
        this.handleSetAgentEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED]: (data) =>
        this.handleSetAllAgentsEnabled(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER]: (data) =>
        this.handleOpenAgentFolder(data),
      [SETTINGS_VIEW_COMMANDS.CREATE_AGENT]: (data) =>
        this.handleCreateAgent(data),
      [SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT]: (data) =>
        this.handleCustomizeAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT]: (data) =>
        this.handleDeleteCustomAgent(data),
      [SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE]: (data) =>
        this.handleRevealAgentFile(data),

      // Agent mode preset handlers
      [SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS]: () =>
        this.withActiveWebview((w) => this.sendAgentModePresets(w)),
      [SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET]: (data) =>
        this.handleApplyAgentModePreset(data),
      [SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET]: (data) =>
        this.handleSaveAgentModePreset(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET]: (data) =>
        this.handleDeleteAgentModePreset(data),

      // Tool dashboard handlers
      [SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA]: () =>
        this.handleGetToolDashboardData(),
      [SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL]: (data) =>
        this.handleOpenToolInstallUrl(data),
      [SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION]: (data) =>
        this.handleInstallToolExtension(data),
      [SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS]: () =>
        this.handleRecheckToolStatus(),

      // LaTeX settings handlers
      [SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS]: () =>
        this.withActiveWebview((w) => this.sendLatexSettingsStatus(w)),
      [SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS]: (data) =>
        this.handleApplyLatexSettings(data),
      [SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP]: () =>
        this.handleInstallLatexWorkshop(),
      [SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND]: (data) =>
        this.handleRunInstallCommand(data),
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
    // Tool dashboard involves network I/O (Zotero probe, etc.) — fire async
    // so it doesn't block the initial render. The frontend shows a loading
    // spinner until data arrives.
    void this.sendToolDashboardData(webview);

    await Promise.all([
      this.sendMemoryData(webview),
      this.sendMemoryEnabled(webview),
      this.sendHistoryData(webview),
      this.sendProfileData(webview),
      this.sendModelSelectionData(webview),
      this.sendAgentSelectionData(webview),
      this.sendCustomAgentDir(webview),
      this.sendSuperYoloEnabled(webview),
      this.sendAgentModePresets(webview),
      this.sendLatexSettingsStatus(webview),
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
    const entries = await listExecutions();
    const historyItems = entries
      .filter(
        (entry) => entry.agentConfig !== null && entry.category !== 'process',
      )
      .map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        agentConfig: entry.agentConfig!,
        description: entry.description,
      }));
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems,
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
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      models,
      helperModel: getHelperModelName(),
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
    const configuredPath = globalSM
      .get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, '')
      .trim();
    const isDefault = configuredPath === '';
    const resolvedPath = await agentDirectories.custom();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: resolvedPath,
      isDefault,
    });
  }

  // ============================================================
  // Super YOLO handler implementations
  // ============================================================

  public async sendSuperYoloEnabled(webview: vscode.Webview): Promise<void> {
    const enabled = workspaceSM.get<boolean>(
      WorkspaceStateKey.SUPER_YOLO_ENABLED,
      false,
    );
    const allowOrchestratorKill = workspaceSM.get<boolean>(
      WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
      true,
    );
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
      enabled,
      reliabilitySettings: getReliabilitySettings(),
      allowOrchestratorKill,
    });
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

  private async handleSetAllowOrchestratorKill(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_ALLOW_ORCHESTRATOR_KILL>,
  ): Promise<void> {
    await workspaceSM.update(
      WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
      data.enabled,
    );
    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
  }

  // ============================================================
  // Agent mode preset handler implementations
  // ============================================================

  /** Read and validate custom presets from workspace state. */
  private getCustomPresets(): AgentModePreset[] {
    const raw = workspaceSM.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []);
    const parsed = z.array(AgentModePresetSchema).safeParse(raw);
    return parsed.success ? parsed.data : [];
  }

  public async sendAgentModePresets(webview: vscode.Webview): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: this.getCustomPresets(),
    });
  }

  /** Resolve agent names to source:name keys for the given category. */
  private resolveAgentKeys(
    category: 'workflow' | 'toolUse',
    names: Set<string>,
  ): string[] {
    const entries = deduplicateByName(
      category === 'workflow' ? getWorkflowAgents() : getToolUseAgents(),
    );
    return entries
      .filter((e) => names.has(e.name))
      .map((e) => createKey(e.source, e.name));
  }

  private async handleApplyAgentModePreset(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.APPLY_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      const preset =
        AGENT_MODE_PRESETS.find((p) => p.id === data.presetId) ??
        this.getCustomPresets().find((p) => p.id === data.presetId);
      if (!preset) {
        await vscode.window.showErrorMessage(
          `Unknown preset: ${data.presetId}`,
        );
        return;
      }

      await loadAgents();

      const workflowKeys = this.resolveAgentKeys(
        'workflow',
        new Set(preset.workflowAgents),
      );
      const toolUseKeys = this.resolveAgentKeys(
        'toolUse',
        new Set(preset.toolUseAgents),
      );

      await workspaceSM.update(WorkspaceStateKey.ENABLED_AGENTS, workflowKeys);
      await workspaceSM.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        toolUseKeys,
      );

      await this.refreshAfterAgentMutation();

      void vscode.window.showInformationMessage(
        `Applied "${preset.name}" preset`,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to apply agent mode preset',
        error,
      );
    }
  }

  private async handleSaveAgentModePreset(
    _data: MessageFor<typeof SETTINGS_VIEW_CMD.SAVE_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      const name = await vscode.window.showInputBox({
        prompt: 'Name for the new preset',
        placeHolder: 'e.g. My Research Setup',
        validateInput: (v) => (v.trim() ? null : 'Name cannot be empty'),
      });
      if (!name) return; // cancelled

      await loadAgents();

      const workflowAgents = getVisibleAgents('workflow').map((e) => e.name);
      const toolUseAgents = getVisibleAgents('toolUse').map((e) => e.name);

      const preset: AgentModePreset = {
        id: `custom-${Date.now()}`,
        name: name.trim(),
        description: `Custom preset: ${[...toolUseAgents, ...workflowAgents].join(', ')}`,
        icon: 'codicon-bookmark',
        workflowAgents,
        toolUseAgents,
      };

      const existing = this.getCustomPresets();
      await workspaceSM.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, [
        ...existing,
        preset,
      ]);

      await this.withActiveWebview((w) => this.sendAgentModePresets(w));

      void vscode.window.showInformationMessage(
        `Saved preset "${name.trim()}"`,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to save agent mode preset',
        error,
      );
    }
  }

  private async handleDeleteAgentModePreset(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT_MODE_PRESET>,
  ): Promise<void> {
    try {
      const presets = this.getCustomPresets();
      const target = presets.find((p) => p.id === data.presetId);
      if (!target) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete preset "${target.name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;

      const updated = presets.filter((p) => p.id !== data.presetId);
      await workspaceSM.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, updated);

      await this.withActiveWebview((w) => this.sendAgentModePresets(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete agent mode preset',
        error,
      );
    }
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

  private async handleSetMemoryEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    await setToolUseMemoryEnabled(data.enabled);
    await this.withActiveWebview((w) => this.sendMemoryEnabled(w));
  }

  // ============================================================
  // History handler implementations
  // ============================================================

  private async handleRerunAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RERUN_AGENT>,
  ): Promise<void> {
    await this.withHistoryConfig(
      data.historyId,
      'Failed to rerun agent',
      async (config) => {
        await vscode.window.showInformationMessage(
          'Rerunning agent from history',
        );
        await runExecuteCommand(config);
      },
    );
  }

  private async handleRestoreAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RESTORE_AGENT>,
  ): Promise<void> {
    await this.withHistoryConfig(
      data.historyId,
      'Failed to restore configuration',
      async (config) => {
        const taskState = agentConfigToTaskState(config);
        await vscode.commands.executeCommand('texra.restoreState', taskState);
      },
    );
  }

  private async handleDeleteAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_AGENT>,
  ): Promise<void> {
    const view = this.getActiveView();
    try {
      const activeIds = getActiveExecutionIds();
      if (activeIds.includes(data.historyId)) {
        await vscode.window.showWarningMessage(
          'Cannot delete a running execution',
        );
        return;
      }
      const deleted = await deleteExecution(data.historyId as ExecutionId);
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
      await deleteAllExecutions(new Set(getActiveExecutionIds()));
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

  private async withHistoryConfig(
    historyId: string,
    errorPrefix: string,
    action: (config: AgentConfig) => Promise<void>,
  ): Promise<void> {
    try {
      const raw = await getExecutionStore(
        historyId as ExecutionId,
      ).readConfig();
      if (!raw) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }
      const config = AgentConfigSchema.parse(raw);
      await action(config);
    } catch (error) {
      await showLoggedErrorMessage(this.channel, errorPrefix, error);
    }
  }

  // ============================================================
  // Profile handler implementations
  // ============================================================

  private async handleSelectAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SELECT_AGENT>,
  ): Promise<void> {
    await selectAgentInMainView(data.agentName, {
      showSuccessMessage: true,
      copyToClipboardOnFailure: false,
    });
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

  /** Refresh settings-view agent list and main-view dropdown after agent mutations. */
  private async refreshAfterAgentMutation(): Promise<void> {
    await this.withActiveWebview((w) => this.sendAgentSelectionData(w));
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

    // Auto-reset helper model if it was just disabled
    if (!data.enabled && getHelperModelName() === data.modelName) {
      const newHelper = updated[0] ?? DEFAULT_HELPER_MODEL;
      await globalSM.update(GlobalStateKey.HELPER_MODEL, newHelper);
    }

    void vscode.commands.executeCommand('texra.refreshAllOptions');
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetHelperModel(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_HELPER_MODEL>,
  ): Promise<void> {
    await globalSM.update(GlobalStateKey.HELPER_MODEL, data.modelName);
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  // ============================================================
  // Agent selection handler implementations
  // ============================================================

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

      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to update agent visibility',
        error,
      );
    }
  }

  private async handleSetAllAgentsEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_ALL_AGENTS_ENABLED>,
  ): Promise<void> {
    try {
      const stateKey =
        data.category === 'workflow'
          ? WorkspaceStateKey.ENABLED_AGENTS
          : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;

      const allAgents =
        data.category === 'workflow' ? getWorkflowAgents() : getToolUseAgents();

      const sourceAgents = allAgents.filter((e) => e.source === data.source);
      const targetKeys = new Set(
        sourceAgents.map((e) => createKey(e.source, e.name)),
      );
      // Legacy entries may use plain agent names without source prefix
      const targetLegacyNames = new Set(sourceAgents.map((e) => e.name));

      // Resolve current state: undefined means "all enabled" (never configured)
      const raw = workspaceSM.get<string[]>(stateKey);
      const current = raw ?? allAgents.map((e) => createKey(e.source, e.name));

      let updated: string[];
      if (data.enabled) {
        // Add all keys from the target source (deduplicated)
        const currentSet = new Set(current);
        updated = [
          ...current,
          ...[...targetKeys].filter((k) => !currentSet.has(k)),
        ];
      } else {
        // Remove both source:name and legacy plain-name entries for this source
        updated = current.filter(
          (k) => !targetKeys.has(k) && !targetLegacyNames.has(k),
        );
      }

      await workspaceSM.update(stateKey, updated);

      await this.refreshAfterAgentMutation();
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

  private async handleRevealAgentFile(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.REVEAL_AGENT_FILE>,
  ): Promise<void> {
    try {
      const key = createKey(data.agentSource, data.agentName);
      const entry = getAgent(key);
      if (!entry?.path) {
        await vscode.window.showErrorMessage(
          `Agent not found or has no file: ${data.agentName}`,
        );
        return;
      }
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(entry.path),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to reveal agent file',
        error,
      );
    }
  }

  private async handleCreateAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.CREATE_AGENT>,
  ): Promise<void> {
    if (data.mode === 'template') {
      await this.createAgentFromTemplate();
    } else {
      await vscode.commands.executeCommand(
        'texra.createAgentWithAI',
        data.category,
      );
    }

    await this.refreshAfterAgentMutation();
  }

  private async createAgentFromTemplate(): Promise<void> {
    try {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new agent (without .yaml extension)',
        placeHolder: 'my_agent',
        validateInput: (value) => {
          if (!value) return 'Name cannot be empty';
          if (value.includes('/') || value.includes('\\'))
            return 'Name cannot contain path separators';
          if (value.includes(' ')) return 'Use underscores instead of spaces';
          if (/[:#\[\]{}|>&*!%@`]/.test(value))
            return 'Name cannot contain YAML-special characters';
          return null;
        },
      });
      if (!name) return;

      const customDir = await agentDirectories.custom();
      await AbsoluteFS.ensureDir(customDir);

      const fileName = name.endsWith('.yaml') ? name : `${name}.yaml`;
      const filePath = path.join(customDir, fileName);

      if (await AbsoluteFS.exists(filePath)) {
        await vscode.window.showWarningMessage(
          `A file named "${fileName}" already exists in the custom agents folder.`,
        );
        return;
      }

      const baseName = name.replace(/\.yaml$/, '');
      const template = `# --- Agent Inheritance (Optional) ---
# inherits: base

name: ${baseName}

# --- Agent Settings ---
settings:
  temperature: 0.1
  isRewrite: true
  documentTag: document
  endTag: '</document>'
  outputExt: tex
  prefills:
    - "<document>"

# --- Agent Prompts ---
prompts:
  systemPrompt: |
    [Define the AI's role and core instructions]

  userPrefix: |
    [Provide context using variables like {{ INPUT_CONTENT }}]

  userRequest:
    - |
        [Define the initial task prompt]
    - |
        [Optional reflection prompt — remove this item if you only need one round]
`;

      await AbsoluteFS.write(filePath, template);
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(filePath),
      );
      await vscode.window.showTextDocument(doc);
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to create agent from template',
        error,
      );
    }
  }

  private async handleCustomizeAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.CUSTOMIZE_AGENT>,
  ): Promise<void> {
    try {
      const key = createKey(data.agentSource, data.agentName);
      const entry = getAgent(key);
      if (!entry?.path) {
        await vscode.window.showErrorMessage(
          `Agent not found or has no file: ${data.agentName}`,
        );
        return;
      }

      const customDir = await agentDirectories.custom();
      const normalizedCustomDir = path.resolve(customDir);
      const sourceDir = await agentDirectories.getDirectory(data.agentSource);
      const relativePath = sourceDir
        ? path.relative(sourceDir, entry.path)
        : path.basename(entry.path);
      const targetPath = path.join(customDir, relativePath);

      // Guard: only write files under the custom agent directory
      if (
        !path.resolve(targetPath).startsWith(normalizedCustomDir + path.sep)
      ) {
        await vscode.window.showErrorMessage(
          `Refusing to copy: target path escapes the custom agents directory.`,
        );
        return;
      }

      await AbsoluteFS.ensureDir(path.dirname(targetPath));

      // Avoid overwriting an existing custom copy with user edits
      if (await AbsoluteFS.exists(targetPath)) {
        const overwrite = 'Overwrite';
        const choice = await vscode.window.showWarningMessage(
          `A custom copy already exists: ${path.basename(targetPath)}`,
          { modal: true },
          overwrite,
        );
        if (choice !== overwrite) return;
      }

      await AbsoluteFS.copy(entry.path, targetPath, { overwrite: true });

      // Also copy the _multiple variant if it stays inside the custom directory
      if (entry.multiplePath) {
        const multipleRelative = sourceDir
          ? path.relative(sourceDir, entry.multiplePath)
          : path.basename(entry.multiplePath);
        const multipleTarget = path.join(customDir, multipleRelative);
        if (
          path
            .resolve(multipleTarget)
            .startsWith(normalizedCustomDir + path.sep)
        ) {
          await AbsoluteFS.ensureDir(path.dirname(multipleTarget));
          try {
            await AbsoluteFS.copy(entry.multiplePath, multipleTarget, {
              overwrite: true,
            });
          } catch {
            // _multiple variant may not exist on disk even if registered
          }
        }
      }

      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(targetPath),
      );
      await vscode.window.showTextDocument(doc, { preview: false });

      void vscode.window.showInformationMessage(
        `Created custom copy: ${path.basename(targetPath)}`,
      );

      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to create custom agent copy',
        error,
      );
    }
  }

  private async handleDeleteCustomAgent(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.DELETE_CUSTOM_AGENT>,
  ): Promise<void> {
    try {
      const key = createKey('custom', data.agentName);
      const entry = getAgent(key);
      if (!entry?.path) {
        await vscode.window.showErrorMessage(
          `Custom agent not found: ${data.agentName}`,
        );
        return;
      }

      // Guard: only delete files under the custom agent directory
      const customDir = await agentDirectories.custom();
      const normalizedPath = path.resolve(entry.path);
      const normalizedCustomDir = path.resolve(customDir);
      if (!normalizedPath.startsWith(normalizedCustomDir + path.sep)) {
        await vscode.window.showErrorMessage(
          `Refusing to delete: file is not inside the custom agents directory.`,
        );
        return;
      }

      await AbsoluteFS.delete(entry.path, { recursive: false });

      // Also delete the _multiple variant if it is inside the custom directory
      if (entry.multiplePath) {
        const normalizedMultiple = path.resolve(entry.multiplePath);
        if (normalizedMultiple.startsWith(normalizedCustomDir + path.sep)) {
          try {
            await AbsoluteFS.delete(entry.multiplePath, { recursive: false });
          } catch (err) {
            // Only ignore FileNotFound; surface other errors
            if (
              !(err instanceof vscode.FileSystemError) ||
              err.code !== 'FileNotFound'
            ) {
              throw err;
            }
          }
        }
      }

      void vscode.window.showInformationMessage(
        `Deleted custom agent: ${data.agentName}`,
      );

      await this.refreshAfterAgentMutation();
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete custom agent',
        error,
      );
    }
  }

  // ============================================================
  // Custom agent directory handler implementations
  // ============================================================

  /** Refresh agent dir + selection after a directory change. */
  private async refreshAgentDirUI(): Promise<void> {
    await agentDirectories.refreshAfterDirChange();
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

  // ============================================================
  // LaTeX settings handler implementations
  // ============================================================

  /** Recommended LaTeX-related VS Code settings and their target values. */
  private static readonly LATEX_RECOMMENDED_SETTINGS: {
    key: string;
    value: unknown;
    field: 'outDir' | 'autoRevealExclude';
    /** Object keys from older TeXRA versions to migrate (remove on apply, clean on reset). */
    legacyKeys?: string[];
  }[] = [
    {
      key: 'latex-workshop.latex.outDir',
      value: '%DIR%/build/',
      field: 'outDir',
    },
    {
      key: 'explorer.autoRevealExclude',
      value: { '**/build/': true },
      field: 'autoRevealExclude',
      // Old setup.ts wrote { 'build/': true } — migrate to **/build/
      legacyKeys: ['build/'],
    },
  ];

  /**
   * Check whether a recommended LaTeX setting's value is active.
   * For string values: exact match.
   * For object values: recommended keys are a subset of the current config.
   */
  private isRecommendedValueSet(
    field: 'outDir' | 'autoRevealExclude',
  ): boolean {
    const setting = SettingsViewMessageHandler.LATEX_RECOMMENDED_SETTINGS.find(
      (s) => s.field === field,
    );
    if (!setting) return false;
    if (!isConfigExplicitlySet(setting.key)) return false;

    const current = getConfig<unknown>(setting.key);
    if (typeof setting.value === 'object' && setting.value !== null) {
      // For object values, check that every recommended key is present
      if (typeof current !== 'object' || current === null) return false;
      const cur = current as Record<string, unknown>;
      const rec = setting.value as Record<string, unknown>;
      const hasRecommended = Object.entries(rec).every(
        ([k, v]) => cur[k] === v,
      );
      if (hasRecommended) return true;
      // Also treat legacy keys as "set" so existing users see the check mark
      // (they'll get migrated to the new key on next Apply).
      if (setting.legacyKeys?.length) {
        return setting.legacyKeys.some((k) => cur[k] !== undefined);
      }
      return false;
    }
    return current === setting.value;
  }

  public async sendLatexSettingsStatus(webview: vscode.Webview): Promise<void> {
    const now = Date.now();
    if (
      !this.latexSettingsCache ||
      now - this.latexSettingsCache.timestamp >= LATEX_SETTINGS_CACHE_TTL
    ) {
      this.latexSettingsCache = {
        settings: await this.detectLatexSettings(),
        timestamp: now,
      };
    }

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS,
      settings: this.latexSettingsCache.settings,
    });
  }

  /** Run all tool checks and build the LaTeX settings status object.
   *  Returns defaults on failure so the webview spinner always dismisses. */
  private async detectLatexSettings(): Promise<LatexSettingsStatus> {
    try {
      const [
        pdflatexOk,
        latexmkOk,
        latexdiffOk,
        latexindentOk,
        perlOk,
        texcountOk,
        gsOk,
        gmOk,
        magickOk,
      ] = await Promise.all([
        checkToolInstalled('pdflatex', false),
        checkToolInstalled('latexmk', false),
        checkToolInstalled('latexdiff', false),
        checkToolInstalled('latexindent', false),
        checkToolInstalled('perl', false),
        checkToolInstalled('texcount', false),
        checkToolInstalled('gs', false),
        checkToolInstalled('gm', false),
        checkToolInstalled('magick', false),
      ]);

      const platform = normalizePlatform(process.platform);

      return {
        outDir: this.isRecommendedValueSet('outDir'),
        autoRevealExclude: this.isRecommendedValueSet('autoRevealExclude'),
        texDistributionInstalled: pdflatexOk || latexmkOk,
        latexWorkshopInstalled: Boolean(
          vscode.extensions.getExtension(LATEX_WORKSHOP_EXT_ID),
        ),
        latexdiffInstalled: latexdiffOk,
        latexindentInstalled: latexindentOk && perlOk,
        texcountInstalled: texcountOk,
        imageProcessingInstalled: gsOk && (gmOk || magickOk),
        platform,
        pdflatexPath: findToolInCommonPaths('pdflatex'),
        latexmkPath: findToolInCommonPaths('latexmk'),
        latexdiffPath: findToolInCommonPaths('latexdiff'),
        latexindentPath: findToolInCommonPaths('latexindent'),
        texcountPath: findToolInCommonPaths('texcount'),
        ghostscriptPath: findToolInCommonPaths('gs'),
        graphicsmagickPath:
          findToolInCommonPaths('gm') ?? findToolInCommonPaths('magick'),
        packageManager: detectPackageManager(),
      };
    } catch (err) {
      this.logger.error(
        this.channel,
        `LaTeX settings detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        ...DEFAULT_LATEX_SETTINGS_STATUS,
        platform: normalizePlatform(process.platform),
      };
    }
  }

  /** Install a VS Code extension and refresh the given view data. */
  private async installExtension(
    extensionId: string,
    refresh: (w: vscode.Webview) => Promise<void>,
  ): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        extensionId,
      );
      void vscode.window.showInformationMessage(
        `Extension "${extensionId}" installed`,
      );
      await this.withActiveWebview(refresh);
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to install extension "${extensionId}"`,
        error,
      );
    }
  }

  private async handleInstallLatexWorkshop(): Promise<void> {
    await this.installExtension(LATEX_WORKSHOP_EXT_ID, (w) =>
      this.sendLatexSettingsStatus(w),
    );
  }

  private async handleApplyLatexSettings(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.APPLY_LATEX_SETTINGS>,
  ): Promise<void> {
    try {
      const targets = data.field
        ? SettingsViewMessageHandler.LATEX_RECOMMENDED_SETTINGS.filter(
            (s) => s.field === data.field,
          )
        : SettingsViewMessageHandler.LATEX_RECOMMENDED_SETTINGS;

      for (const { key, value, legacyKeys } of targets) {
        let resolvedValue: unknown = data.reset ? undefined : value;

        if (typeof value === 'object' && value !== null) {
          const recommended = value as Record<string, unknown>;
          // Read only the user's explicit global entries — not VS Code defaults —
          // so we don't leak built-in defaults into settings.json.
          const inspection = vscode.workspace.getConfiguration().inspect(key);
          const globalObj = (inspection?.globalValue ?? {}) as Record<
            string,
            unknown
          >;
          const remaining = { ...globalObj };

          // Always clean up legacy keys from older TeXRA versions.
          for (const k of legacyKeys ?? []) {
            delete remaining[k];
          }

          if (data.reset) {
            // Remove the recommended keys, keep the user's other entries.
            for (const k of Object.keys(recommended)) {
              delete remaining[k];
            }
            resolvedValue =
              Object.keys(remaining).length > 0 ? remaining : undefined;
          } else {
            // Merge recommended keys into existing config.
            resolvedValue = { ...remaining, ...recommended };
          }
        }

        await updateConfig(key, resolvedValue, {
          target: vscode.ConfigurationTarget.Global,
          prefix: false,
        });
      }

      await this.withActiveWebview((w) => this.sendLatexSettingsStatus(w));
      const verb = data.reset ? 'reset' : 'applied';
      void vscode.window.showInformationMessage(
        data.field
          ? `LaTeX setting ${verb}`
          : `All recommended LaTeX settings ${verb}`,
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to update LaTeX settings',
        error,
      );
    }
  }

  /** Allowlist of commands that may be executed via the Run in Terminal button. */
  private static readonly ALLOWED_INSTALL_COMMANDS: ReadonlySet<string> =
    new Set([
      HOMEBREW_INSTALL_COMMAND,
      SCOOP_INSTALL_COMMAND,
      ...Object.values(DEPENDENCY_INSTALL_COMMANDS).flatMap((platforms) =>
        Object.values(platforms).flatMap((cmds) =>
          cmds.map((cmd) => cmd.command),
        ),
      ),
    ]);

  private async handleRunInstallCommand(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RUN_INSTALL_COMMAND>,
  ): Promise<void> {
    if (
      !SettingsViewMessageHandler.ALLOWED_INSTALL_COMMANDS.has(
        data.installCommand,
      )
    ) {
      this.logger.warn(
        this.channel,
        `Rejected unknown install command: ${data.installCommand}`,
      );
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: 'TeXRA Install',
      hideFromUser: false,
    });
    terminal.show();
    terminal.sendText(data.installCommand);
  }

  // ============================================================
  // Tool dashboard handler implementations
  // ============================================================

  public async sendToolDashboardData(webview: vscode.Webview): Promise<void> {
    const items = await buildToolDashboardItems();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
    });
  }

  private async handleGetToolDashboardData(): Promise<void> {
    await this.withActiveWebview((w) => this.sendToolDashboardData(w));
  }

  private async handleOpenToolInstallUrl(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_TOOL_INSTALL_URL>,
  ): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(data.url));
  }

  private async handleInstallToolExtension(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.INSTALL_TOOL_EXTENSION>,
  ): Promise<void> {
    await this.installExtension(data.extensionId, (w) =>
      this.sendToolDashboardData(w),
    );
  }

  private async handleRecheckToolStatus(): Promise<void> {
    await this.withActiveWebview((w) => this.sendToolDashboardData(w));
  }
}
