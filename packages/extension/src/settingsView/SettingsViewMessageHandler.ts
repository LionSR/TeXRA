/**
 * Schema-driven message handler for SettingsView.
 *
 * Combines handlers from MemoryView, HistoryView, and ProfileView
 * into a single unified message handler.
 *
 * Domain-specific handlers are delegated to focused handler classes:
 * - AgentHandlers: agent selection, directories, and teams
 * - LatexSettingsHandlers: LaTeX tool detection and recommended settings
 */
import * as vscode from 'vscode';

// Shared schemas and dispatchers
import {
  SettingsMemoryController,
  type SettingsMemoryMessage,
} from '@controllers/settingsView/SettingsMemoryController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { platform } from '@platform/platform';
import {
  getAgentsBySource,
  loadAgents,
  toRemoteAgentProfileData,
} from '@agent/index';
import {
  getExecutionStore,
  listExecutions,
  deleteExecution,
  deleteAllExecutions,
} from '@agent/storage';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { getActiveExecutionIds } from '@agent/runtime/executionRegistry';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { SupabaseClient } from '@auth/SupabaseClient';
import { FREE_TIER, ULTRA_TIER, MAX_TIER } from '@auth/config';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { runExecuteCommand } from '@commands/agent/executeCommand';
import {
  formatChatAsMarkdown,
  formatChatAsLatex,
  generateExportFilename,
  type ChatExportInput,
} from '@commands/history/chatExportFormatter';
import {
  BaseViewMessageHandler,
  SETTINGS_VIEW_COMMANDS,
} from '@common/webview';
import {
  GlobalStateKey,
  WorkspaceStateKey,
  globalSM,
  workspaceSM,
} from '@common/state';
import { bus } from '@eventBus/ProgressEventBus';
import { SecretManager, type ApiProvider } from '@frontend/secretManager';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { selectAgentInMainView } from '@frontend/agents/remoteAgentUtils';
import {
  applyGitAuthorConfig,
  readGitAuthorSettings,
} from '@frontend/git/gitAuthorSetup';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import {
  isInlineCriticismEnabled,
  setInlineCriticismEnabled,
} from '@frontend/latex/inlineCriticism';
import { compileLatex2Pdf } from '@latex/texTools';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { buildStreamInfo } from '@progressView/streamInfoUtils';
import type { ExecutionId } from '@shared/schemas';
import type { HistoryItem } from '@shared/schemas/historyViewMessages';
import {
  dispatchSettingsViewInbound,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
  type SettingsMessageFor,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas/settingsViewMessages';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
  PROVIDER_VSCODE_SETTINGS,
} from '@shared/constants/providers';
import {
  NESTED_DELEGATION_DEPTH_RANGE,
  clampNestedDelegationDepth,
} from '@shared/constants/delegationPolicy';
import type {
  RemoteAgent,
  ProviderKeyStatus,
  ProviderVscodeSetting,
  NumberVscodeSetting,
} from '@shared/schemas/profileViewMessages';
import {
  getLastCheckResults,
  refreshToolAvailability,
  refreshDisabledToolCache,
} from '@tools/toolAvailability';
import {
  parseCodexSandboxMode,
  parseCodexReasoningEffort,
  parseCodexApprovalPolicy,
} from '@tools/codexConfig';
import {
  CLAUDE_AGENT_DEFAULT_MODEL,
  parseClaudeAgentEffort,
  parseClaudeAgentModel,
  parseClaudeAgentPermissionMode,
} from '@tools/claudeAgentConfig';
import { findExternalToolDef } from '@tools/externalToolDefs';
import {
  issuePollingSource,
  listIssueSubscriptionBindings,
  listPRSubscriptionBindings,
  listRepoSubscriptionBindings,
  prPollingSource,
  repoPollingSource,
  unbindAllForIssue,
  unbindAllForPR,
  unbindAllForRepo,
} from '@tools/github';
import { BASH_APPROVAL_CONFIG_KEY } from '@tools/approval/bashApproval';
import {
  MEMORY_STORAGE_ROOT,
  MAX_PINNED_MEMORIES,
} from '@tools/memory/constants';
import {
  buildFile,
  countPinnedMemories,
  parseFrontmatter,
  setPinnedMeta,
} from '@tools/memory/memoryMeta';
import { resolveMemoryStoragePath } from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';
import { setToolUseMemoryEnabled } from '@utils/config/constants';
import {
  getGlobalStreaming,
  setGlobalStreaming,
  getProviderStreaming,
  setProviderStreaming,
  getProviderEndpoint,
  setProviderEndpoint,
  supportsCustomEndpoint,
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@utils/config/providerConfig';
import { getConfig, updateConfig } from '@utils/config/configUtils';
import { setToolEnabled } from '@utils/config/constants';
import { loadMemoryItems, loadMemoryPreview } from './utils/memoryFileSystem';
import { buildToolDashboardItems } from './utils/toolDashboardData';
import { AgentHandlers } from './handlers/agentHandlers';
import { LatexSettingsHandlers } from './handlers/latexSettingsHandlers';
import type { SettingsHandlerContext } from './handlers/SettingsHandlerContext';

// Re-use the shared type helper for extracting specific message types.
type MessageFor<C extends SettingsViewInboundMessage['command']> =
  SettingsMessageFor<C>;

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
  return defs.map((def) => ({
    ...def,
    value: def.globalStateKey
      ? (globalSM?.get<boolean>(def.globalStateKey, false) ?? false)
      : getConfig<boolean>(def.key, false),
  }));
}

function getReliabilitySettings(): NumberVscodeSetting[] {
  return RELIABILITY_SETTINGS.map(({ defaultValue, ...def }) => ({
    ...def,
    value: getConfig<number>(def.key, defaultValue),
  }));
}

async function getProviderKeyStatuses(): Promise<ProviderKeyStatus[]> {
  const secretStatuses = await loadApiKeyStatusMap(
    platform().secrets,
    SecretManager.API_PROVIDERS,
  );
  return SecretManager.API_PROVIDERS.map((provider) => ({
    provider,
    displayName: getProviderDisplayName(
      provider,
      PROVIDER_DISPLAY_NAMES[provider],
    ),
    status: secretStatuses[provider],
    keyUrl: getProviderKeyUrl(provider, PROVIDER_URLS[provider]),
    streaming: getProviderStreaming(provider),
    customEndpoint: getProviderEndpoint(provider),
    supportsCustomEndpoint: supportsCustomEndpoint(provider),
    vscodeSettings: getProviderVscodeSettings(provider),
  }));
}

const modelSelectionController = new SettingsModelSelectionController({
  state: {
    getEnabledModels: () =>
      globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS),
    setEnabledModels: async (models) => {
      await globalSM.update(GlobalStateKey.ENABLED_MODELS, models);
    },
    getHelperModel: () => globalSM.get<string>(GlobalStateKey.HELPER_MODEL),
    setHelperModel: async (model) => {
      await globalSM.update(GlobalStateKey.HELPER_MODEL, model);
    },
    getReasoningLevelOverrides: () =>
      globalSM.get<Record<string, string>>(GlobalStateKey.REASONING_LEVELS),
    setReasoningLevelOverrides: async (overrides) => {
      await globalSM.update(GlobalStateKey.REASONING_LEVELS, overrides);
    },
    getPreferShortModelNames: () =>
      globalSM.get<boolean>(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
    setPreferShortModelNames: async (enabled) => {
      await globalSM.update(GlobalStateKey.PREFER_SHORT_MODEL_NAMES, enabled);
    },
  },
  useIncludedAccess: () =>
    getServerSideKeyService().getUseIncludedModelAccess(),
  getUserTier: () => getServerSideKeyService().getUserTier() ?? undefined,
});

export class SettingsViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: SettingsViewInboundHandlerRegistry;

  // Domain-specific handler delegates
  private readonly agentHandlers: AgentHandlers;
  private readonly latexHandlers: LatexSettingsHandlers;
  private readonly memoryController: SettingsMemoryController;
  private readonly profileKeyController: SettingsProfileKeyController;

  constructor(context: vscode.ExtensionContext) {
    super('SettingsView', { trackActiveView: true });

    const ctx: SettingsHandlerContext = {
      channel: this.channel,
      logger: this.logger,
      extensionContext: context,
      withActiveWebview: (fn) => this.withActiveWebview(fn),
    };

    this.memoryController = new SettingsMemoryController({
      prompt: new VscodePromptHost(),
      loadMemoryItems,
      loadMemoryPreview,
      isMemoryEnabled: () =>
        globalSM?.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true) ?? true,
      setMemoryEnabled: setToolUseMemoryEnabled,
      resolveStoragePath: resolveMemoryStoragePath,
      storage: StorageFS,
      maxPinnedMemories: MAX_PINNED_MEMORIES,
      parseMemoryFile: parseFrontmatter,
      buildMemoryFile: buildFile,
      setPinnedMeta,
      countPinnedMemories,
    });
    this.profileKeyController = new SettingsProfileKeyController({
      prompt: new VscodePromptHost(),
      externalOpener: new VscodeExternalOpener(),
      getProviderDisplayName: (provider) =>
        PROVIDER_DISPLAY_NAMES[provider] ?? provider,
      getProviderKeyUrl: (provider) =>
        getProviderKeyUrl(provider, PROVIDER_URLS[provider]),
      getApiKeySecretName: (provider) =>
        SecretManager.getApiKeySecretName(provider as ApiProvider),
      setSecret: (key, value) => SecretManager.set(key, value),
      deleteSecret: (key) => SecretManager.delete(key),
      refreshAfterKeyChange: () => this.refreshAfterKeyChange(),
    });
    this.agentHandlers = new AgentHandlers(ctx, () =>
      this.refreshAfterAgentMutation(),
    );
    this.latexHandlers = new LatexSettingsHandlers(ctx);

    this.handlerRegistry = this.createHandlerRegistry();

    // Lifetime == extension; bus is process-global so no dispose needed.
    const refreshSubscriptions = () =>
      void this.withActiveWebview((w) => this.sendPRSubscriptions(w));
    bus.on('prSubscriptionsChanged', refreshSubscriptions);
    bus.on('prSubscriptionBindingsChanged', refreshSubscriptions);
    bus.on('repoSubscriptionsChanged', refreshSubscriptions);
    bus.on('repoSubscriptionBindingsChanged', refreshSubscriptions);
    bus.on('issueSubscriptionsChanged', refreshSubscriptions);
    bus.on('issueSubscriptionBindingsChanged', refreshSubscriptions);
    bus.on('toolAvailabilityChanged', () => {
      void this.withActiveWebview((w) =>
        this.sendToolDashboardData(w, { skipChecks: true }),
      );
    });
  }

  private createHandlerRegistry(): SettingsViewInboundHandlerRegistry {
    return {
      // Lifecycle: webview signals it's mounted; populate every tab's
      // initial data via the single `sendAllData` source of truth.
      [SETTINGS_VIEW_COMMANDS.WEBVIEW_READY]: () =>
        this.withActiveWebview((w) => this.sendAllData(w)),

      // Navigation handlers
      [SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS]: () =>
        this.handleOpenVscodeSettings(),

      // Memory handlers
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA]: () =>
        this.withActiveWebview((w) => this.sendMemoryData(w)),
      [SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW]: (data) =>
        this.handleGetMemoryPreview(data),
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
      [SETTINGS_VIEW_COMMANDS.PIN_MEMORY]: (data) => this.handlePinMemory(data),
      [SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY]: (data) =>
        this.handleUnpinMemory(data),

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
      [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD]: (data) =>
        this.handleExportChat(data, 'md'),
      [SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX]: (data) =>
        this.handleExportChat(data, 'tex'),

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
      [SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL]: async (data) => {
        await vscode.env.openExternal(vscode.Uri.parse(data.url));
      },

      // Model selection handlers
      [SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION]: () =>
        this.withActiveWebview((w) => this.sendModelSelectionData(w)),
      [SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED]: (data) =>
        this.handleSetModelEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL]: (data) =>
        this.handleSetHelperModel(data),
      [SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL]: (data) =>
        this.handleSetModelReasoningLevel(data),
      [SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES]: (data) =>
        this.handleSetPreferShortModelNames(data),

      // Multi-agent coordination handlers
      [SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendSuperYoloEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL]: (data) =>
        this.updateBooleanAndSendSuperYolo(
          WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
          data,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_DETACH_SUBAGENTS_ON_STOP]: (data) =>
        this.updateBooleanAndSendSuperYolo(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          data,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_NESTED_DELEGATION_MAX_DEPTH]: (data) =>
        this.handleSetNestedDelegationMaxDepth(data),

      // ── Delegated to AgentHandlers ──

      [SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION]: () =>
        this.withActiveWebview((w) =>
          this.agentHandlers.sendAgentSelectionData(w),
        ),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML]: (data) =>
        this.agentHandlers.handleOpenAgentYaml(data),
      [SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED]: (data) =>
        this.agentHandlers.handleSetAgentEnabled(data),
      [SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED]: (data) =>
        this.agentHandlers.handleSetAllAgentsEnabled(data),
      [SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER]: (data) =>
        this.agentHandlers.handleOpenAgentFolder(data),
      [SETTINGS_VIEW_COMMANDS.CREATE_AGENT]: (data) =>
        this.agentHandlers.handleCreateAgent(data),
      [SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT]: (data) =>
        this.agentHandlers.handleCustomizeAgent(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT]: (data) =>
        this.agentHandlers.handleDeleteCustomAgent(data),
      [SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE]: (data) =>
        this.agentHandlers.handleRevealAgentFile(data),
      [SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT]: (data) =>
        this.agentHandlers.handleViewRemoteAgentPrompt(data),

      // Custom agent directory
      [SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR]: () =>
        this.withActiveWebview((w) => this.agentHandlers.sendCustomAgentDir(w)),
      [SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR]: () =>
        this.agentHandlers.handleSetCustomAgentDir(),
      [SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR]: () =>
        this.agentHandlers.handleResetCustomAgentDir(),

      // Agent teams
      [SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS]: () =>
        this.withActiveWebview((w) =>
          this.agentHandlers.sendAgentModePresets(w),
        ),
      [SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET]: (data) =>
        this.agentHandlers.handleApplyAgentModePreset(data),
      [SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET]: (data) =>
        this.agentHandlers.handleSaveAgentModePreset(data),
      [SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET]: (data) =>
        this.agentHandlers.handleDeleteAgentModePreset(data),

      // Git author settings handlers
      [SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS]: () =>
        this.withActiveWebview((w) => this.sendGitAuthorSettings(w)),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_MARK_COMMITS,
          data.enabled,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_AUTHOR_NAME,
          data.name,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_AUTHOR_EMAIL,
          data.email,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT]: (data) =>
        this.updateGitAuthorSetting(
          WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
          data.enabled,
        ),

      // GitHub token handlers
      [SETTINGS_VIEW_COMMANDS.GET_GITHUB_TOKEN_STATUS]: () =>
        this.withActiveWebview((w) => this.sendGitHubTokenStatus(w)),
      [SETTINGS_VIEW_COMMANDS.SET_GITHUB_TOKEN]: () =>
        this.handleSetGitHubToken(),
      [SETTINGS_VIEW_COMMANDS.REMOVE_GITHUB_TOKEN]: () =>
        this.handleRemoveGitHubToken(),
      [SETTINGS_VIEW_COMMANDS.OPEN_GITHUB_TOKEN_URL]: async () => {
        await vscode.env.openExternal(
          vscode.Uri.parse(
            'https://github.com/settings/tokens/new?description=TeXRA%20PR%20subscription&scopes=repo',
          ),
        );
      },
      [SETTINGS_VIEW_COMMANDS.GET_PR_SUBSCRIPTIONS]: () =>
        this.withActiveWebview((w) => this.sendPRSubscriptions(w)),
      [SETTINGS_VIEW_COMMANDS.UNSUBSCRIBE_PR]: (data) => {
        // Path form mirrors GitHub's REST URL shape:
        //   owner/repo               → repo
        //   owner/repo/pulls/N       → PR
        //   owner/repo/issues/N      → issue
        const k = data.key;
        const removed = k.includes('/pulls/')
          ? unbindAllForPR(k, extensionAgentRuntimeHost)
          : k.includes('/issues/')
            ? unbindAllForIssue(k, extensionAgentRuntimeHost)
            : unbindAllForRepo(k, extensionAgentRuntimeHost);
        if (removed === 0) {
          void vscode.window.showInformationMessage(
            `No active subscription for ${k}.`,
          );
        }
      },
      [SETTINGS_VIEW_COMMANDS.OPEN_PR_SUBSCRIPTION_STREAM]: (data) =>
        this.handleOpenPRSubscriptionStream(data),

      // ── Delegated to LatexSettingsHandlers ──

      [SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS]: () =>
        this.withActiveWebview((w) =>
          this.latexHandlers.sendLatexSettingsStatus(w),
        ),
      [SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS]: (data) =>
        this.latexHandlers.handleApplyLatexSettings(data),
      [SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP]: () =>
        this.latexHandlers.handleInstallLatexWorkshop(),
      [SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND]: (data) =>
        this.latexHandlers.handleRunInstallCommand(data),
      [SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES]: () =>
        this.withActiveWebview((w) =>
          this.latexHandlers.sendLatexConfigValues(w),
        ),
      [SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE]: (data) =>
        this.latexHandlers.handleSetLatexConfigValue(data),
      [SETTINGS_VIEW_COMMANDS.GET_INLINE_CRITICISM_ENABLED]: () =>
        this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w)),
      [SETTINGS_VIEW_COMMANDS.SET_INLINE_CRITICISM_ENABLED]: (data) =>
        this.handleSetInlineCriticismEnabled(data.enabled),

      // Approval settings handlers
      [SETTINGS_VIEW_COMMANDS.GET_APPROVAL_SETTINGS]: () =>
        this.withActiveWebview((w) => this.sendApprovalSettings(w)),
      [SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED]: (data) =>
        this.handleSetApprovalEnabled(BASH_APPROVAL_CONFIG_KEY, data.enabled),
      [SETTINGS_VIEW_COMMANDS.SET_CODEX_SANDBOX_MODE]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CODEX_SANDBOX_MODE,
          data.mode,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CODEX_REASONING_EFFORT]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CODEX_REASONING_EFFORT,
          data.effort,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CODEX_APPROVAL_POLICY]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CODEX_APPROVAL_POLICY,
          data.policy,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_MODEL]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CLAUDE_AGENT_MODEL,
          data.model,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_PERMISSION_MODE]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
          data.mode,
        ),
      [SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_EFFORT]: (data) =>
        this.updateAgentSetting(
          WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
          data.effort,
        ),

      // Tool dashboard handlers
      [SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA]: () =>
        this.withActiveWebview((w) => this.sendToolDashboardData(w)),
      [SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL]: async (data) => {
        await vscode.env.openExternal(vscode.Uri.parse(data.url));
      },
      [SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION]: (data) =>
        this.handleInstallToolExtension(data),
      [SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS]: () =>
        refreshToolAvailability(extensionAgentRuntimeHost),
      [SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL]: async (data) => {
        await setToolEnabled(data.toolId, data.enabled);
        refreshDisabledToolCache();
        // Re-render with cached check results — no network re-probe needed
        await this.withActiveWebview((w) =>
          this.sendToolDashboardData(w, { skipChecks: true }),
        );
      },
      [SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND]: (data) =>
        this.handleRunToolCommand(data),
    };
  }

  private handleRunToolCommand(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.RUN_TOOL_COMMAND>,
  ): void {
    const def = findExternalToolDef(data.toolId);
    const command =
      data.kind === 'install' ? def?.installCommand : def?.authCommand;
    if (!command) {
      this.logger.debug(this.channel, 'No command for tool', { data });
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `TeXRA: ${def?.name ?? data.toolId}`,
    });
    terminal.show();
    terminal.sendText(command);
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

  private async primeIncludedAccessIfAuthenticated(): Promise<boolean> {
    const serverSideKeyService = getServerSideKeyService();
    if (
      !serverSideKeyService.getUseIncludedModelAccess() ||
      !(await SupabaseClient.isAuthenticated())
    ) {
      return false;
    }

    return serverSideKeyService.canUseServerSideKeys();
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendAllData(webview: vscode.Webview): Promise<void> {
    // Tool dashboard involves network I/O (Zotero probe, etc.) — fire async
    // so it doesn't block the initial render. The frontend shows a loading
    // spinner until data arrives.
    void this.sendToolDashboardData(webview);

    const hasServerSideAccess = await this.primeIncludedAccessIfAuthenticated();
    await this.sendProfileData(webview, { hasServerSideAccess });
    await this.sendModelSelectionData(webview);

    await Promise.all([
      this.sendMemoryData(webview),
      this.sendMemoryEnabled(webview),
      this.sendHistoryData(webview),
      this.agentHandlers.sendAgentSelectionData(webview),
      this.agentHandlers.sendCustomAgentDir(webview),
      this.sendSuperYoloEnabled(webview),
      this.agentHandlers.sendAgentModePresets(webview),
      this.sendGitAuthorSettings(webview),
      this.sendGitHubTokenStatus(webview),
      this.sendPRSubscriptions(webview),
      this.sendApprovalSettings(webview),
      this.latexHandlers.sendLatexSettingsStatus(webview),
      this.latexHandlers.sendLatexConfigValues(webview),
      this.sendInlineCriticismEnabled(webview),
    ]);
  }

  public async sendMemoryData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.memoryController.getMemoryDataMessage(),
    );
  }

  private async handleGetMemoryPreview(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW>,
  ): Promise<void> {
    try {
      await this.postSettingsMemoryMessage(
        await this.memoryController.getMemoryPreviewMessage(data.storagePath),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to load memory preview',
        error,
      );
      await this.postSettingsMemoryMessage(
        this.memoryController.getMemoryPreviewErrorMessage(data.storagePath),
      );
    }
  }

  public async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(this.memoryController.getMemoryEnabledMessage());
  }

  public async sendInlineCriticismEnabled(
    webview: vscode.Webview,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED,
      enabled: isInlineCriticismEnabled(),
    });
  }

  private async handleSetInlineCriticismEnabled(
    enabled: boolean,
  ): Promise<void> {
    await setInlineCriticismEnabled(enabled);
    await this.withActiveWebview((w) => this.sendInlineCriticismEnabled(w));
  }

  public async sendHistoryData(webview: vscode.Webview): Promise<void> {
    const entries = await listExecutions();
    const historyItems = entries
      .filter(
        (entry) => entry.agentConfig !== null && entry.category !== 'process',
      )
      .map((entry): HistoryItem => {
        const cfg = entry.agentConfig!;
        const base = {
          agent: cfg.agent,
          model: cfg.model,
          instruction: cfg.instruction,
        };
        return {
          id: entry.id,
          timestamp: entry.timestamp,
          agentConfig:
            cfg.agentCategory === 'toolUse'
              ? { agentCategory: 'toolUse' as const, ...base }
              : {
                  agentCategory: 'workflow' as const,
                  ...base,
                  inputFile: cfg.inputFile,
                  inputFiles: cfg.inputFiles,
                  mediaFile: cfg.mediaFile,
                  mediaFiles: cfg.mediaFiles,
                  referenceFile: cfg.referenceFile,
                  referenceFiles: cfg.referenceFiles,
                  auxiliaryFile: cfg.auxiliaryFile,
                  auxiliaryFiles: cfg.auxiliaryFiles,
                  outputFiles: cfg.outputFiles,
                  toolConfig: cfg.toolConfig,
                },
          description: entry.description,
        };
      });
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY,
      historyItems,
    });
  }

  public async sendProfileData(
    webview: vscode.Webview,
    options: { hasServerSideAccess?: boolean } = {},
  ): Promise<void> {
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
      options.hasServerSideAccess ??
      (await serverSideKeyService.canUseServerSideKeys());

    const user = await SupabaseClient.getUser();
    const authContext = await SupabaseClient.getUserAuthContext();

    await loadAgents();
    const remoteAgents: RemoteAgent[] = getAgentsBySource('remote').map(
      toRemoteAgentProfileData,
    );

    const apiAccessMode = serverSideKeyService.getUseIncludedModelAccess()
      ? 'included'
      : 'personal';

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
    const data = modelSelectionController.buildSelectionData();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ...data,
    });
  }

  // ============================================================
  // Multi-agent coordination handler implementations
  // ============================================================

  public async sendSuperYoloEnabled(webview: vscode.Webview): Promise<void> {
    const allowOrchestratorKill = workspaceSM.get<boolean>(
      WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
      true,
    );
    const detachSubagentsOnStop = workspaceSM.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    );
    const nestedDelegationMaxDepth = clampNestedDelegationDepth(
      workspaceSM.get<number>(
        WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH,
        NESTED_DELEGATION_DEPTH_RANGE.default,
      ),
    );
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
      enabled: true,
      reliabilitySettings: getReliabilitySettings(),
      allowOrchestratorKill,
      detachSubagentsOnStop,
      nestedDelegationMaxDepth,
    });
  }

  private async updateBooleanAndSendSuperYolo(
    key: WorkspaceStateKey,
    data: { enabled: boolean },
  ): Promise<void> {
    await workspaceSM.update(key, data.enabled);
    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
  }

  private async handleSetNestedDelegationMaxDepth(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_NESTED_DELEGATION_MAX_DEPTH>,
  ): Promise<void> {
    await workspaceSM.update(
      WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH,
      clampNestedDelegationDepth(data.value),
    );
    await this.withActiveWebview((w) => this.sendSuperYoloEnabled(w));
  }

  // ============================================================
  // Git author settings handler implementations
  // ============================================================

  private async sendGitAuthorSettings(
    webview: vscode.Webview,
    settings?: ReturnType<typeof readGitAuthorSettings>,
  ): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      ...(settings ?? readGitAuthorSettings()),
    });
  }

  private async updateGitAuthorSetting(
    key: WorkspaceStateKey,
    value: unknown,
  ): Promise<void> {
    await workspaceSM.update(key, value);
    const settings = applyGitAuthorConfig();
    await this.withActiveWebview((w) =>
      this.sendGitAuthorSettings(w, settings),
    );
  }

  // ============================================================
  // GitHub token handler implementations
  // ============================================================

  private async sendGitHubTokenStatus(webview: vscode.Webview): Promise<void> {
    const status = await SecretManager.gitHubTokenExists();
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS,
      status,
    });
  }

  private async handleSetGitHubToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      prompt:
        'Paste a GitHub personal access token (repo or public_repo scope)',
      password: true,
      placeHolder: 'ghp_…',
      ignoreFocusOut: true,
    });
    if (!token) return;
    try {
      await SecretManager.set(SecretManager.GITHUB_TOKEN_KEY, token.trim());
      void vscode.window.showInformationMessage('GitHub token saved.');
      await this.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to save GitHub token',
        error,
      );
    }
  }

  private async handleRemoveGitHubToken(): Promise<void> {
    try {
      await SecretManager.delete(SecretManager.GITHUB_TOKEN_KEY);
      void vscode.window.showInformationMessage('GitHub token removed.');
      await this.withActiveWebview((w) => this.sendGitHubTokenStatus(w));
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to remove GitHub token',
        error,
      );
    }
  }

  private async sendPRSubscriptions(webview: vscode.Webview): Promise<void> {
    const state = ProgressViewProvider.getInstance()?.state;
    const toEntry = (
      key: string,
      streamIds: readonly string[],
    ): { key: string; owners: { streamId: string; label: string }[] } => ({
      key,
      owners: streamIds.map((streamId) => ({
        streamId,
        label: state
          ? (buildStreamInfo(state, streamId, 'all')?.label ?? streamId)
          : streamId,
      })),
    });
    const prEntries = listPRSubscriptionBindings(
      prPollingSource.activeKeys(),
    ).map(({ key, streamIds }) => toEntry(key, streamIds));
    const repoEntries = listRepoSubscriptionBindings(
      repoPollingSource.activeKeys(),
    ).map(({ key, streamIds }) => toEntry(key, streamIds));
    const issueEntries = listIssueSubscriptionBindings(
      issuePollingSource.activeKeys(),
    ).map(({ key, streamIds }) => toEntry(key, streamIds));

    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS,
      subscriptions: [...prEntries, ...repoEntries, ...issueEntries],
    });
  }

  private async handleOpenPRSubscriptionStream(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_PR_SUBSCRIPTION_STREAM>,
  ): Promise<void> {
    const provider = ProgressViewProvider.getInstance();
    if (!provider) {
      await vscode.window.showErrorMessage(
        'Progress View is not available. Please try again.',
      );
      return;
    }

    const { state } = provider;
    if (!state.streamLogs.has(data.streamId)) {
      await vscode.window.showWarningMessage(
        'The agent stream is no longer available.',
      );
      return;
    }

    await provider.showProgressView();

    // If the current filter would hide the target stream, clear it to 'all'
    // so SET_ACTIVE_STREAM doesn't silently land on the wrong tab.
    if (
      buildStreamInfo(state, data.streamId, state.agentCategoryFilter) === null
    ) {
      state.agentCategoryFilter = 'all';
      provider.syncFullView();
    }

    provider.setActiveStream(data.streamId);
  }

  // ============================================================
  // Approval settings handler implementations
  // ============================================================

  private async sendApprovalSettings(webview: vscode.Webview): Promise<void> {
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
      bashApprovalEnabled: getConfig<boolean>(BASH_APPROVAL_CONFIG_KEY, true),
      codexSandboxMode: parseCodexSandboxMode(
        workspaceSM.get<string>(
          WorkspaceStateKey.CODEX_SANDBOX_MODE,
          'workspace-write',
        ) ?? 'workspace-write',
      ),
      codexReasoningEffort: parseCodexReasoningEffort(
        workspaceSM.get<string>(
          WorkspaceStateKey.CODEX_REASONING_EFFORT,
          'high',
        ) ?? 'high',
      ),
      codexApprovalPolicy: parseCodexApprovalPolicy(
        workspaceSM.get<string>(
          WorkspaceStateKey.CODEX_APPROVAL_POLICY,
          'never',
        ) ?? 'never',
      ),
      claudeAgentModel: parseClaudeAgentModel(
        workspaceSM.get<string>(
          WorkspaceStateKey.CLAUDE_AGENT_MODEL,
          CLAUDE_AGENT_DEFAULT_MODEL,
        ) ?? CLAUDE_AGENT_DEFAULT_MODEL,
      ),
      claudeAgentPermissionMode: parseClaudeAgentPermissionMode(
        workspaceSM.get<string>(
          WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
          'acceptEdits',
        ) ?? 'acceptEdits',
      ),
      claudeAgentEffort: parseClaudeAgentEffort(
        workspaceSM.get<string>(
          WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
          'high',
        ) ?? 'high',
      ),
    });
  }

  private async handleSetApprovalEnabled(
    configKey: string,
    enabled: boolean,
  ): Promise<void> {
    await updateConfig(configKey, enabled, {
      target: 'global',
      prefix: false,
    });
    await this.withActiveWebview((w) => this.sendApprovalSettings(w));
  }

  private async updateAgentSetting(
    key: WorkspaceStateKey,
    value: string,
  ): Promise<void> {
    await workspaceSM.update(key, value);
    await this.withActiveWebview((w) => this.sendApprovalSettings(w));
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
      const fileUri = vscode.Uri.file(absolutePath);

      // Open markdown files in preview mode (read-only rendered view)
      if (absolutePath.toLowerCase().endsWith('.md')) {
        await vscode.commands.executeCommand('markdown.showPreview', fileUri);
      } else {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
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
    try {
      await this.postSettingsMemoryMessage(
        await this.memoryController.deleteMemory(data),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete memory',
        error,
      );
      await this.withActiveWebview((w) => this.sendMemoryData(w));
    }
  }

  private async handleSetMemoryEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    await this.postSettingsMemoryMessage(
      await this.memoryController.setMemoryEnabled(data.enabled),
    );
  }

  private async handlePinMemory(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.PIN_MEMORY>,
  ): Promise<void> {
    await this.setMemoryPinned(data.storagePath, true);
  }

  private async handleUnpinMemory(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.UNPIN_MEMORY>,
  ): Promise<void> {
    await this.setMemoryPinned(data.storagePath, false);
  }

  private async postSettingsMemoryMessage(
    message: SettingsMemoryMessage | null,
  ): Promise<void> {
    if (!message) return;
    await this.withActiveWebview(async (webview) => {
      await webview.postMessage(message);
    });
  }

  private async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
  ): Promise<void> {
    try {
      await this.postSettingsMemoryMessage(
        pinned
          ? await this.memoryController.pinMemory(storagePath)
          : await this.memoryController.unpinMemory(storagePath),
      );
    } catch (error) {
      const action = pinned ? 'pin' : 'unpin';
      await showLoggedErrorMessage(
        this.channel,
        `Failed to ${action} memory`,
        error,
      );
    }
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
    try {
      const activeIds = getActiveExecutionIds();
      if (activeIds.includes(data.historyId)) {
        await vscode.window.showWarningMessage(
          'Cannot delete a running execution',
        );
        return;
      }
      const deleted = await deleteExecution(data.historyId as ExecutionId);
      if (deleted) {
        await this.withActiveWebview((w) => this.sendHistoryData(w));
      } else {
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
    try {
      await deleteAllExecutions(new Set(getActiveExecutionIds()));
      await vscode.window.showInformationMessage('Agent history cleared');
      await this.withActiveWebview(async (w) => {
        await w.postMessage({
          command: SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED,
        });
      });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to clear history',
        error,
      );
    }
  }

  private async handleExportChat(
    data: { historyId: string },
    format: 'md' | 'tex',
  ): Promise<void> {
    try {
      const store = getExecutionStore(data.historyId as ExecutionId);
      const [rawConfig, conversation, meta] = await Promise.all([
        store.readConfig(),
        store.readConversation(),
        store.readMeta(),
      ]);

      if (!rawConfig) {
        await vscode.window.showErrorMessage('History item not found');
        return;
      }

      if (!conversation) {
        await vscode.window.showErrorMessage(
          'No conversation data available for this execution',
        );
        return;
      }

      const config = AgentConfigSchema.parse(rawConfig);

      const exportInput: ChatExportInput = {
        timestamp: meta?.timestamp ?? new Date().toISOString(),
        description: meta?.description,
        config: {
          agent: config.agent,
          model: config.model,
          instruction: config.instruction,
          inputFile: config.inputFile,
          inputFiles: config.inputFiles,
          mediaFile: config.mediaFile,
          mediaFiles: config.mediaFiles,
          referenceFile: config.referenceFile,
          referenceFiles: config.referenceFiles,
          auxiliaryFile: config.auxiliaryFile,
          auxiliaryFiles: config.auxiliaryFiles,
          outputFiles: config.outputFiles,
        },
        messages: conversation,
      };

      const filename = generateExportFilename(exportInput, format);
      const storagePath = `executions/${data.historyId}/${filename}`;

      const content =
        format === 'md'
          ? formatChatAsMarkdown(exportInput)
          : formatChatAsLatex(exportInput);

      await StorageFS.write(storagePath, content);
      const absolutePath = StorageFS.fullPath(storagePath);

      if (format === 'tex') {
        // Compile LaTeX to PDF
        const { pathToLocation } = await import('@utils/files');
        const location = pathToLocation(absolutePath);
        const compiled = await compileLatex2Pdf(location);

        if (compiled) {
          // Open the generated PDF
          const pdfPath = absolutePath.replace(/\.tex$/, '.pdf');
          const pdfUri = vscode.Uri.file(pdfPath);
          await vscode.commands.executeCommand('vscode.open', pdfUri);
          void vscode.window.showInformationMessage(
            `Chat exported and compiled: ${filename.replace('.tex', '.pdf')}`,
          );
        } else {
          // Compilation failed — open the .tex source instead
          const doc = await vscode.workspace.openTextDocument(absolutePath);
          await vscode.window.showTextDocument(doc, { preview: false });
          void vscode.window.showWarningMessage(
            'LaTeX compilation failed. The .tex source file has been opened instead.',
          );
        }
      } else {
        // Open Markdown file
        const doc = await vscode.workspace.openTextDocument(absolutePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        void vscode.window.showInformationMessage(`Chat exported: ${filename}`);
      }
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to export chat',
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
    await getServerSideKeyService().setUseIncludedModelAccess(
      data.mode === 'included',
    );

    // Included Access routes through the TeXRA relay — OpenRouter bypasses it.
    // Disable OpenRouter when switching to Included Access so routing is consistent.
    let openRouterDisabled = false;
    if (
      data.mode === 'included' &&
      globalSM?.get<boolean>(GlobalStateKey.USE_OPENROUTER, false)
    ) {
      await globalSM.update(GlobalStateKey.USE_OPENROUTER, false);
      openRouterDisabled = true;
    }

    // Access mode affects model availability — invalidate cached options.
    invalidateModelOptionsCache();
    const hasServerSideAccess = await this.primeIncludedAccessIfAuthenticated();
    await this.withActiveWebview(async (w) => {
      await this.sendProfileData(w, { hasServerSideAccess });
      await this.sendModelSelectionData(w);
    });

    const modeLabel =
      data.mode === 'included' ? 'Included Access' : 'My Own Keys';
    const suffix = openRouterDisabled
      ? ' OpenRouter has been turned off (not compatible with Included Access).'
      : '';
    void vscode.window.showInformationMessage(
      `Model access changed to: ${modeLabel}.${suffix}`,
    );
  }

  private async handleSetProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PROVIDER_KEY>,
  ): Promise<void> {
    const provider = data.provider;
    try {
      await this.profileKeyController.setProviderKey(provider);
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to set ${PROVIDER_DISPLAY_NAMES[provider] ?? provider} API key`,
        error,
      );
      // On error, still refresh settings view to reflect current key state.
      await this.withActiveWebview((w) => this.sendProfileData(w));
    }
  }

  private async handleRemoveProviderKey(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.REMOVE_PROVIDER_KEY>,
  ): Promise<void> {
    const provider = data.provider;
    try {
      await this.profileKeyController.removeProviderKey(provider);
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        `Failed to remove ${PROVIDER_DISPLAY_NAMES[provider] ?? provider} API key`,
        error,
      );
      // On error, still refresh settings view to reflect current key state.
      await this.withActiveWebview((w) => this.sendProfileData(w));
    }
  }

  /**
   * Refresh main view API key status, model options, AND settings-view profile
   * after key changes. Combines all refreshes into a single call to avoid
   * redundant async work when callers would otherwise call sendProfileData separately.
   */
  private async refreshAfterKeyChange(): Promise<void> {
    // Invalidate caches so downstream refreshes see fresh key state.
    invalidateModelOptionsCache();
    invalidateApiKeyCache();
    await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
    await Promise.all([
      vscode.commands.executeCommand('texra.refreshAllOptions'),
      this.withActiveWebview((w) => this.sendProfileData(w)),
    ]);
  }

  /** Refresh settings-view agent list and main-view dropdown after agent mutations. */
  private async refreshAfterAgentMutation(): Promise<void> {
    await Promise.all([
      this.withActiveWebview((w) =>
        this.agentHandlers.sendAgentSelectionData(w),
      ),
      vscode.commands.executeCommand('texra.refreshAllOptions'),
    ]);
  }

  private async handleOpenProviderKeyUrl(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.OPEN_PROVIDER_KEY_URL>,
  ): Promise<void> {
    await this.profileKeyController.openProviderKeyUrl(data.provider);
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

    // Check if this setting is backed by globalSM instead of VS Code config
    const def = Object.values(PROVIDER_VSCODE_SETTINGS)
      .flat()
      .find((s) => s.key === data.key);
    if (def?.globalStateKey) {
      await globalSM?.update(def.globalStateKey, data.value);
    } else {
      await updateConfig(data.key, data.value, {
        target: 'global',
        prefix: false,
      });
    }

    const affectsModelAvailability =
      def?.globalStateKey === GlobalStateKey.USE_OPENROUTER;
    if (affectsModelAvailability) {
      invalidateModelOptionsCache();
    }

    await this.withActiveWebview(async (w) => {
      await Promise.all([
        this.sendProfileData(w),
        this.sendSuperYoloEnabled(w),
        affectsModelAvailability
          ? this.sendModelSelectionData(w)
          : Promise.resolve(),
      ]);
    });

    if (affectsModelAvailability) {
      await vscode.commands.executeCommand('texra.refreshAllOptions');
    }
  }

  // ============================================================
  // Model selection handler implementations
  // ============================================================

  private async handleSetModelEnabled(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MODEL_ENABLED>,
  ): Promise<void> {
    await modelSelectionController.setModelEnabled({
      modelName: data.modelName,
      enabled: data.enabled,
    });
    invalidateModelOptionsCache();
    await Promise.all([
      vscode.commands.executeCommand('texra.refreshAllOptions'),
      this.withActiveWebview((w) => this.sendModelSelectionData(w)),
    ]);
  }

  private async handleSetHelperModel(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_HELPER_MODEL>,
  ): Promise<void> {
    await modelSelectionController.setHelperModel(data.modelName);
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetModelReasoningLevel(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MODEL_REASONING_LEVEL>,
  ): Promise<void> {
    await modelSelectionController.setReasoningLevel({
      modelName: data.modelName,
      level: data.level,
    });
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  private async handleSetPreferShortModelNames(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_PREFER_SHORT_MODEL_NAMES>,
  ): Promise<void> {
    await modelSelectionController.setPreferShortModelNames(data.enabled);
    await this.withActiveWebview((w) => this.sendModelSelectionData(w));
  }

  // ============================================================
  // Tool dashboard handler implementations
  // ============================================================

  public async sendToolDashboardData(
    webview: vscode.Webview,
    options?: { skipChecks?: boolean },
  ): Promise<void> {
    const cachedResults = options?.skipChecks
      ? (getLastCheckResults() ?? undefined)
      : undefined;
    const items = await buildToolDashboardItems(cachedResults);
    await webview.postMessage({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
      items,
    });
  }

  private async handleInstallToolExtension(
    data: MessageFor<typeof SETTINGS_VIEW_CMD.INSTALL_TOOL_EXTENSION>,
  ): Promise<void> {
    await this.latexHandlers.installExtension(data.extensionId);
  }
}
