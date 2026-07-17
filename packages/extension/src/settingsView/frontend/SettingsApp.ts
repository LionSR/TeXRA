/** Main container for the unified settings view. */

import { html, nothing, type TemplateResult } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/hostBridge';

// Local imports - shared signals
import { SignalWatcher } from '@shared/signals';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas and constants
import {
  dispatchSettingsViewOutbound,
  SETTINGS_TAB,
  SETTINGS_TAB_PANEL_BY_NAME,
  SETTINGS_TAB_ORDER,
  SETTINGS_TAB_PANEL_NAMES,
  type SettingsTabName,
  type SettingsViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { assertSupported, isKnownUnsupported } from '@shared/utils/dispatcher';
import {
  registerTeXRAWebAwesomeIcons,
  waIcon,
  type TeXRAIconName,
} from '@shared/wa/webAwesomeIcons';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/apiKeyProviders';

// Local imports - settings view
import '@shared/wa/tabs';
import type { WaTabShowEvent } from '@shared/wa/tabs';
import { settingsViewStyles } from './styles';

// Side-effect: register tab components
import './tabs/MemoryTab';
import './tabs/GoalTab';
import './tabs/HistoryTab';
import './tabs/ModelsTab';
import './tabs/AgentsTab';
import './tabs/MultiAgentTab';
import './tabs/ToolsTab';
import './tabs/AIAgentsTab';
import './tabs/GitTab';
import './tabs/LaTeXTab';
import './components/profile/ProviderKeyModal';

// Local imports - module-scope settings state + composed message handlers
import { settingsViewHandlers } from './messageDispatcher';
import {
  agentSubTab,
  allowOrchestratorKill,
  apiAccessMode,
  authenticated,
  bashApprovalEnabled,
  chatgptAuth,
  claudeAgentEffort,
  claudeAgentModel,
  claudeAgentPermissionMode,
  codexApprovalPolicy,
  codexReasoningEffort,
  codexSandboxMode,
  customAgentDir,
  customAgentDirIsDefault,
  customPresets,
  desktopCrashReportingConfigured,
  desktopCrashReportingEnabled,
  detachSubagentsOnStop,
  gitAuthorEmail,
  gitAuthorName,
  githubTokenStatus,
  gitMarkCommits,
  gitSettingsLoaded,
  gitWorktreeSupport,
  globalStreamingDefault,
  goalItems,
  helperModel,
  historyItems,
  inlineCriticismEnabled,
  kimiCodeAuth,
  latexConfigValues,
  latexConfigValuesLoaded,
  latexSettingsLoaded,
  latexSettingsStatus,
  memoryEnabled,
  memoryItems,
  memoryToggleDisabled,
  modelSelectionItems,
  orchestratorAgents,
  preferShortModelNames,
  prSubscriptions,
  providerKeyModal,
  providerKeyStatuses,
  quotaAutoSwitched,
  reliabilitySettings,
  resetSettingsState,
  selectedTabIndex,
  spendingStatus,
  tier,
  toolDashboardItems,
  toolDashboardLoaded,
  toolUseAgents,
  unsupportedCommands,
  userEmail,
  workflowAgents,
  type ProviderKeyModalTarget,
} from './settingsState';
import type { HistoryTab } from './tabs/HistoryTab';

registerTeXRAWebAwesomeIcons();

const HISTORY_ACTION_COMMANDS: Record<string, string> = {
  delete: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
  restore: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
  rerun: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
  'export-md': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
  'export-tex': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
  'export-html': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_HTML,
};

const API_KEY_PROVIDER_SET = new Set<string>(API_KEY_PROVIDER_IDS);

type SettingsTabMetadata = {
  readonly icon: TeXRAIconName;
  readonly label: string;
};

const SETTINGS_TAB_METADATA: Record<SettingsTabName, SettingsTabMetadata> = {
  MEMORY: { icon: 'database', label: 'Memory' },
  HISTORY: { icon: 'clock-rotate-left', label: 'History' },
  MODELS: { icon: 'server', label: 'Models' },
  AGENTS: { icon: 'robot', label: 'Agents' },
  MULTI_AGENT: { icon: 'users', label: 'Multi-Agent' },
  TOOLS: { icon: 'screwdriver-wrench', label: 'Tools' },
  AI_AGENTS: { icon: 'robot', label: 'Integrations' },
  GIT: { icon: 'code-branch', label: 'Git' },
  LATEX: { icon: 'file-code', label: 'LaTeX' },
  GOAL: { icon: 'compass', label: 'Goal' },
};

/** Header tab strip: panel name, icon, and label in display order. */
const SETTINGS_TABS = SETTINGS_TAB_ORDER.map((name) => ({
  name,
  panel: SETTINGS_TAB_PANEL_BY_NAME[name],
  ...SETTINGS_TAB_METADATA[name],
}));

/** Create an event handler that forwards event.detail to a postMessage command. */
function forwardDetail<T extends Record<string, unknown>>(
  command: string,
): (event: CustomEvent<T>) => void {
  return (event: CustomEvent<T>) => postMessage(command, event.detail);
}

/** Create an event handler that sends a postMessage command with no payload. */
function forwardCommand(command: string): () => void {
  return () => postMessage(command);
}

// Cast: BaseWebviewApp is abstract, but SignalWatcher expects a concrete constructor.
// Safe because SettingsApp implements all abstract members below.
const SettingsAppBase = SignalWatcher(
  BaseWebviewApp as unknown as new (...args: any[]) => BaseWebviewApp,
);

@customElement('settings-app')
export class SettingsApp extends SettingsAppBase {
  // Static 'styles' override lost through mixin type erasure; still works at runtime.
  static styles = [designTokens, commonViewStyles, settingsViewStyles];

  // Tab refs
  @query('history-tab') private historyTab?: HistoryTab;

  constructor() {
    super();
    // State lives at module scope in `settingsState.ts` (mirrors
    // progressView/frontend/progressState.ts). That state is shared across
    // remounts in the same JS context (tests, hot reload), so reset it here
    // to match the pre-migration per-instance-field behavior, where every
    // signal started fresh on construction.
    resetSettingsState();
  }

  // Outbound message handlers (extension host → settings webview), composed
  // from the domain slices under `./slices/` (see `messageDispatcher.ts`).
  // HISTORY_CLEARED is overridden here to additionally clear the
  // `<history-tab>` search box — a DOM ref this component owns via `@query`,
  // not signal state, so it can't live in the slice itself. `assertSupported`
  // narrows the known-real `historySlice` handler out of the `Handler |
  // Unsupported` union `SettingsViewOutboundHandlerRegistry` now requires
  // (see `@shared/utils/dispatcher`) — this call site invokes a specific
  // entry directly rather than going through the dispatcher, so it needs the
  // narrowing dispatch itself would otherwise provide.
  private readonly messageHandlers: SettingsViewOutboundHandlerRegistry = {
    ...settingsViewHandlers,
    [SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED]: (data) => {
      assertSupported(
        settingsViewHandlers[SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED],
      )(data);
      this.historyTab?.clearSearch();
    },
  };

  protected override handleMessage(raw: unknown): void {
    dispatchSettingsViewOutbound(raw, this.messageHandlers, (error) => {
      const command =
        raw && typeof raw === 'object' && 'command' in raw
          ? String((raw as { command: unknown }).command)
          : 'unknown';
      this.logSchemaError(
        `[SettingsApp] Message validation failed for command "${command}".`,
        error,
      );
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.isDesktopHost && selectedTabIndex.get() === 0) {
      selectedTabIndex.set(SETTINGS_TAB.MODELS);
    }
  }

  private handleTabShow(event: WaTabShowEvent): void {
    const selectedIndex = SETTINGS_TAB_PANEL_NAMES.indexOf(event.detail.name);
    if (selectedIndex >= 0) {
      selectedTabIndex.set(selectedIndex);
    }
  }

  // Memory event handlers
  private handleMemoryRefresh = forwardCommand(
    SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA,
  );

  private handleMemoryOpenFolder = forwardCommand(
    SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
  );

  private handleMemoryToggleEnabled = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED,
  );

  private handleMemoryOpenItem = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE,
  );

  private handleMemoryDeleteItem(
    event: CustomEvent<{ storagePath: string; displayPath?: string }>,
  ): void {
    const { storagePath, displayPath = storagePath } = event.detail;
    postMessage(SETTINGS_VIEW_COMMANDS.DELETE_MEMORY, {
      storagePath,
      displayPath,
    });
  }

  private handleMemoryLoadPreview = forwardDetail(
    SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
  );

  private handleMemoryPinItem = forwardDetail(
    SETTINGS_VIEW_COMMANDS.PIN_MEMORY,
  );

  private handleMemoryUnpinItem = forwardDetail(
    SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY,
  );

  // History event handlers
  private handleHistoryAction(
    event: CustomEvent<{ action: string; historyId: string }>,
  ): void {
    const command = HISTORY_ACTION_COMMANDS[event.detail.action];
    if (!command) return;
    postMessage(command, { historyId: event.detail.historyId });
  }

  private handleClearHistory = forwardCommand(
    SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY,
  );

  // Profile event handlers
  private handleSignIn = forwardCommand(SETTINGS_VIEW_COMMANDS.SIGN_IN);

  private handleSignOut = forwardCommand(SETTINGS_VIEW_COMMANDS.SIGN_OUT);

  private handleApiAccessMode = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
  );

  private openProviderKeyFlow(target: {
    provider: string;
    displayName: string;
  }): void {
    if (!this.isDesktopHost) {
      postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, {
        provider: target.provider,
      });
      return;
    }

    providerKeyModal.set(target);
  }

  private handleSetProviderKey(event: CustomEvent<{ provider: string }>): void {
    const status = providerKeyStatuses
      .get()
      .find((entry) => entry.provider === event.detail.provider);
    this.openProviderKeyFlow({
      provider: event.detail.provider,
      displayName: status?.displayName ?? event.detail.provider,
    });
  }

  private handleProviderKeySubmit(
    event: CustomEvent<{ provider: string; apiKey: string }>,
  ): void {
    providerKeyModal.set(null);
    postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, event.detail);
  }

  private readonly handleProviderKeyCancel = (): void => {
    providerKeyModal.set(null);
  };

  private getDefaultProviderKeyTarget(): ProviderKeyModalTarget {
    const helperProvider = modelSelectionItems
      .get()
      .find((model) => model.name === helperModel.get())?.provider;
    const keyStatuses = providerKeyStatuses.get();
    const fallbackProvider =
      keyStatuses.find((entry) => entry.status === 'not-set')?.provider ??
      API_KEY_PROVIDER_IDS[0];
    const provider =
      helperProvider && API_KEY_PROVIDER_SET.has(helperProvider)
        ? helperProvider
        : fallbackProvider;
    const status = keyStatuses.find((entry) => entry.provider === provider);
    return {
      provider,
      displayName:
        status?.displayName ?? PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    };
  }

  private readonly handleSetDefaultProviderKey = (): void => {
    const target = this.getDefaultProviderKeyTarget();
    selectedTabIndex.set(SETTINGS_TAB.MODELS);
    this.openProviderKeyFlow(target);
  };

  private handleRemoveProviderKey = forwardDetail(
    SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
  );

  private handleOpenProviderKeyUrl = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL,
  );

  private handleSetProviderStreaming = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_PROVIDER_STREAMING,
  );

  private handleSetProviderEndpoint = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_PROVIDER_ENDPOINT,
  );

  private handleSetGlobalStreaming = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_GLOBAL_STREAMING,
  );

  private handleSetProviderVscodeSetting = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_PROVIDER_VSCODE_SETTING,
  );

  private handleOpenUrl = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL,
  );

  // Model selection event handlers
  private handleSetModelEnabled = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
  );

  private handleSetHelperModel = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_HELPER_MODEL,
  );

  private handleSetReasoningLevel = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL,
  );

  private handleSetPreferShortModelNames = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES,
  );

  private handleRequestModelAccess = forwardDetail(
    SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS,
  );

  // Agent selection event handlers
  private handleOpenAgentYaml = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML,
  );

  private handleSetAgentEnabled = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
  );

  private handleSetAllAgentsEnabled = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED,
  );

  private handleOpenAgentFolder = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER,
  );

  private handleCreateAgent = forwardDetail(
    SETTINGS_VIEW_COMMANDS.CREATE_AGENT,
  );

  private handleCustomizeAgent = forwardDetail(
    SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT,
  );

  private handleDeleteCustomAgent = forwardDetail(
    SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT,
  );

  private handleSetCustomAgentDir = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR,
  );

  private handleResetCustomAgentDir = forwardCommand(
    SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR,
  );

  private handleRevealAgentFile = forwardDetail(
    SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE,
  );

  private handleViewRemoteAgentPrompt = forwardDetail(
    SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT,
  );

  private handleAllowOrchestratorKillToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL,
  );

  private handleDetachSubagentsOnStopToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_DETACH_SUBAGENTS_ON_STOP,
  );

  private handleApplyAgentModePreset = forwardDetail(
    SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
  );

  private handleSaveAgentModePreset = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET,
  );

  private handleDeleteAgentModePreset = forwardDetail(
    SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET,
  );

  // Tool dashboard event handlers
  private handleToolOpenUrl = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL,
  );

  private handleToolInstallExtension = forwardDetail(
    SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION,
  );

  private handleToolRecheck = forwardCommand(
    SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
  );

  private handleToolToggle = forwardDetail(SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL);

  private handleToolRunCommand = forwardDetail(
    SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
  );

  // Approval settings event handlers
  private handleBashApprovalToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_BASH_APPROVAL_ENABLED,
  );

  private handleCodexSandboxModeChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CODEX_SANDBOX_MODE,
  );

  private handleCodexReasoningEffortChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CODEX_REASONING_EFFORT,
  );

  private handleCodexApprovalPolicyChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CODEX_APPROVAL_POLICY,
  );

  private handleClaudeAgentModelChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_MODEL,
  );

  private handleClaudeAgentPermissionModeChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_PERMISSION_MODE,
  );

  private handleClaudeAgentEffortChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CLAUDE_AGENT_EFFORT,
  );

  // Git settings event handlers
  private handleGitMarkCommitsToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS,
  );

  private handleGitAuthorNameChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
  );

  private handleGitAuthorEmailChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL,
  );

  private handleWorktreeSupportToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT,
  );

  // GitHub token handlers
  private handleGitHubTokenSet = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SET_GITHUB_TOKEN,
  );

  private handleGitHubTokenRemove = forwardCommand(
    SETTINGS_VIEW_COMMANDS.REMOVE_GITHUB_TOKEN,
  );

  private handleGitHubTokenOpenUrl = forwardCommand(
    SETTINGS_VIEW_COMMANDS.OPEN_GITHUB_TOKEN_URL,
  );

  // ChatGPT subscription sign-in handlers
  private handleChatGptSignIn = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT,
  );

  private handleChatGptSignOut = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT,
  );

  private handleSetChatGptPreferSubscription = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
  );

  private handleSetChatGptSubscriptionToolUseOnly = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_CHATGPT_SUBSCRIPTION_TOOL_USE_ONLY,
  );

  // Kimi Code subscription sign-in handlers
  private handleKimiCodeSignIn = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SIGN_IN_KIMI_CODE,
  );

  private handleKimiCodeSignOut = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SIGN_OUT_KIMI_CODE,
  );

  private handleSetKimiCodePreferSubscription = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_KIMI_CODE_PREFER_SUBSCRIPTION,
  );

  private handleSetKimiCodeSubscriptionToolUseOnly = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_KIMI_CODE_SUBSCRIPTION_TOOL_USE_ONLY,
  );

  private handleDesktopCrashReportingToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_ENABLED,
  );

  private handleDesktopCrashReportingDsnSet = forwardCommand(
    SETTINGS_VIEW_COMMANDS.SET_DESKTOP_CRASH_REPORTING_DSN,
  );

  private handleUnsubscribePR = forwardDetail(
    SETTINGS_VIEW_COMMANDS.UNSUBSCRIBE_PR,
  );

  private handleOpenPRSubscriptionStream = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_PR_SUBSCRIPTION_STREAM,
  );

  // LaTeX settings event handlers
  private handleApplyLatexSettings = forwardDetail(
    SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS,
  );

  private handleInstallLatexWorkshop = forwardCommand(
    SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
  );

  private handleSetLatexConfigValue = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
  );

  private handleSetInlineCriticismEnabled = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_INLINE_CRITICISM_ENABLED,
  );

  private handleRunInstallCommand = forwardDetail(
    SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
  );

  private handleOpenVscodeSettings = forwardCommand(
    SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
  );

  private renderHeader(): TemplateResult {
    const settingsButton = isKnownUnsupported(
      unsupportedCommands.get(),
      SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
    )
      ? nothing
      : html`
          <wa-button
            aria-label="Open VS Code Settings"
            appearance="plain"
            size="small"
            title="Open VS Code Settings"
            @click=${this.handleOpenVscodeSettings}
          >
            ${waIcon('gear')}
          </wa-button>
        `;

    if (authenticated.get()) {
      return html`
        <div class="settings-header">
          <div class="settings-header-user">
            ${waIcon('circle-user', { className: 'settings-header-user-icon' })}
            <div class="settings-header-info">
              <span class="settings-header-email">${userEmail.get()}</span>
              <span class="settings-header-tier">${tier.get()} Plan</span>
            </div>
          </div>
          <div class="settings-header-actions">
            ${settingsButton}
            <wa-button
              class="settings-header-auth-button"
              appearance="outlined"
              variant="neutral"
              size="small"
              title="Sign out"
              @click=${this.handleSignOut}
            >
              ${waIcon('xmark', { slot: 'start' })} Sign out
            </wa-button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="settings-header">
        <span class="settings-header-signed-out">
          Use TeXRA with your own API keys
        </span>
        <div class="settings-header-actions">
          ${settingsButton}
          <wa-button
            class="settings-header-auth-button"
            appearance="outlined"
            variant="neutral"
            size="small"
            title="Set provider API key"
            @click=${this.handleSetDefaultProviderKey}
          >
            ${waIcon('key', { slot: 'start' })} Set API key
          </wa-button>
          <wa-button
            class="settings-header-auth-button"
            appearance="filled"
            variant="brand"
            size="small"
            title="Sign in"
            @click=${this.handleSignIn}
          >
            ${waIcon('user', { slot: 'start' })} Sign in
          </wa-button>
        </div>
      </div>
    `;
  }

  private renderProviderKeyModal(): TemplateResult | typeof nothing {
    const modal = providerKeyModal.get();
    if (modal == null) {
      return nothing;
    }

    return html`
      <provider-key-modal
        .provider=${modal.provider}
        .displayName=${modal.displayName}
        @provider-key-submit=${this.handleProviderKeySubmit}
        @provider-key-cancel=${this.handleProviderKeyCancel}
      ></provider-key-modal>
    `;
  }

  private renderDesktopUnavailablePanel(
    title: string,
    description: string,
  ): TemplateResult {
    return html`
      <div class="tab-content-container">
        <div class="settings-unavailable">
          <div class="settings-unavailable-title">
            ${waIcon('ban', { className: 'settings-unavailable-icon' })}
            ${title}
          </div>
          <div>${description}</div>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    const desktopHost = this.isDesktopHost;

    return html`
      <div class="settings-container">
        ${this.renderHeader()}

        <wa-tab-group
          class="settings-tabs"
          .active=${
            SETTINGS_TAB_PANEL_NAMES[selectedTabIndex.get()] ?? 'memory'
          }
          @wa-tab-show=${this.handleTabShow}
        >
          ${SETTINGS_TABS.filter(
            (tab) =>
              tab.panel !== 'goal' ||
              !isKnownUnsupported(
                unsupportedCommands.get(),
                SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
              ),
          ).map(
            (tab) =>
              html`<wa-tab panel=${tab.panel}
                >${waIcon(tab.icon, { className: 'settings-tab-icon' })}
                ${tab.label}</wa-tab
              >`,
          )}

          <wa-tab-panel name="memory">
            <memory-tab
              .items=${memoryItems.get()}
              .enabled=${memoryEnabled.get()}
              .toggleDisabled=${memoryToggleDisabled.get()}
              @memory-refresh=${this.handleMemoryRefresh}
              @memory-open-folder=${this.handleMemoryOpenFolder}
              @memory-toggle-enabled=${this.handleMemoryToggleEnabled}
              @memory-open-item=${this.handleMemoryOpenItem}
              @memory-delete-item=${this.handleMemoryDeleteItem}
              @memory-load-preview=${this.handleMemoryLoadPreview}
              @memory-pin-item=${this.handleMemoryPinItem}
              @memory-unpin-item=${this.handleMemoryUnpinItem}
            ></memory-tab>
          </wa-tab-panel>

          ${
            isKnownUnsupported(
              unsupportedCommands.get(),
              SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
            )
              ? nothing
              : html`
                  <wa-tab-panel name="goal">
                    <goal-tab .items=${goalItems.get()}></goal-tab>
                  </wa-tab-panel>
                `
          }

          <wa-tab-panel name="history">
            <history-tab
              .items=${historyItems.get()}
              .unsupportedCommands=${unsupportedCommands.get()}
              @history-action=${this.handleHistoryAction}
              @history-clear=${this.handleClearHistory}
            ></history-tab>
          </wa-tab-panel>

          <wa-tab-panel name="models">
            <models-tab
              .authenticated=${authenticated.get()}
              .apiAccessMode=${apiAccessMode.get()}
              .spendingStatus=${spendingStatus.get()}
              .quotaAutoSwitched=${quotaAutoSwitched.get()}
              .providerKeyStatuses=${providerKeyStatuses.get()}
              .chatgptAuth=${chatgptAuth.get()}
              .kimiCodeAuth=${kimiCodeAuth.get()}
              .globalStreamingDefault=${globalStreamingDefault.get()}
              .modelSelectionItems=${modelSelectionItems.get()}
              .reliabilitySettings=${reliabilitySettings.get()}
              .helperModel=${helperModel.get()}
              .preferShortModelNames=${preferShortModelNames.get()}
              @profile-api-access-mode=${this.handleApiAccessMode}
              @provider-key-set=${this.handleSetProviderKey}
              @provider-key-remove=${this.handleRemoveProviderKey}
              @provider-key-open-url=${this.handleOpenProviderKeyUrl}
              @provider-streaming-set=${this.handleSetProviderStreaming}
              @provider-endpoint-set=${this.handleSetProviderEndpoint}
              @provider-global-streaming-set=${this.handleSetGlobalStreaming}
              @provider-vscode-setting-set=${
                this.handleSetProviderVscodeSetting
              }
              @provider-open-url=${this.handleOpenUrl}
              @model-enabled-set=${this.handleSetModelEnabled}
              @helper-model-set=${this.handleSetHelperModel}
              @model-reasoning-level-set=${this.handleSetReasoningLevel}
              @prefer-short-model-names-set=${
                this.handleSetPreferShortModelNames
              }
              @model-access-request=${this.handleRequestModelAccess}
              @chatgpt-sign-in=${this.handleChatGptSignIn}
              @chatgpt-sign-out=${this.handleChatGptSignOut}
              @chatgpt-prefer-subscription-set=${
                this.handleSetChatGptPreferSubscription
              }
              @chatgpt-subscription-tool-use-only-set=${
                this.handleSetChatGptSubscriptionToolUseOnly
              }
              @kimi-code-sign-in=${this.handleKimiCodeSignIn}
              @kimi-code-sign-out=${this.handleKimiCodeSignOut}
              @kimi-code-prefer-subscription-set=${
                this.handleSetKimiCodePreferSubscription
              }
              @kimi-code-subscription-tool-use-only-set=${
                this.handleSetKimiCodeSubscriptionToolUseOnly
              }
            ></models-tab>
          </wa-tab-panel>

          <wa-tab-panel name="agents">
            <agents-tab
              .workflowAgents=${workflowAgents.get()}
              .toolUseAgents=${toolUseAgents.get()}
              .customAgentDir=${customAgentDir.get()}
              .customAgentDirIsDefault=${customAgentDirIsDefault.get()}
              .initialSubTab=${agentSubTab.get()}
              .userTier=${tier.get()}
              .unsupportedCommands=${unsupportedCommands.get()}
              @agent-open-yaml=${this.handleOpenAgentYaml}
              @agent-enabled-set=${this.handleSetAgentEnabled}
              @agent-all-enabled-set=${this.handleSetAllAgentsEnabled}
              @agent-open-folder=${this.handleOpenAgentFolder}
              @agent-reveal-file=${this.handleRevealAgentFile}
              @agent-create=${this.handleCreateAgent}
              @agent-customize=${this.handleCustomizeAgent}
              @agent-delete-custom=${this.handleDeleteCustomAgent}
              @agent-set-custom-dir=${this.handleSetCustomAgentDir}
              @agent-reset-custom-dir=${this.handleResetCustomAgentDir}
              @save-agent-mode-preset=${this.handleSaveAgentModePreset}
              @agent-view-remote-prompt=${this.handleViewRemoteAgentPrompt}
            ></agents-tab>
          </wa-tab-panel>

          <wa-tab-panel name="multi-agent">
            <multi-agent-tab
              .customPresets=${customPresets.get()}
              .orchestratorAgents=${orchestratorAgents.get()}
              .allowOrchestratorKill=${allowOrchestratorKill.get()}
              .detachSubagentsOnStop=${detachSubagentsOnStop.get()}
              .worktreeSupport=${gitWorktreeSupport.get()}
              @allow-orchestrator-kill-toggle=${
                this.handleAllowOrchestratorKillToggle
              }
              @detach-subagents-on-stop-toggle=${
                this.handleDetachSubagentsOnStopToggle
              }
              @worktree-support-toggle=${this.handleWorktreeSupportToggle}
              @apply-agent-mode-preset=${this.handleApplyAgentModePreset}
              @delete-agent-mode-preset=${this.handleDeleteAgentModePreset}
            ></multi-agent-tab>
          </wa-tab-panel>

          <wa-tab-panel name="tools">
            <tools-tab
              .items=${toolDashboardItems.get()}
              .loaded=${toolDashboardLoaded.get()}
              .bashApprovalEnabled=${bashApprovalEnabled.get()}
              .showDesktopCrashReporting=${!isKnownUnsupported(
                unsupportedCommands.get(),
                SETTINGS_VIEW_COMMANDS.GET_DESKTOP_CRASH_REPORTING,
              )}
              .desktopCrashReportingEnabled=${desktopCrashReportingEnabled.get()}
              .desktopCrashReportingConfigured=${desktopCrashReportingConfigured.get()}
              @tool-open-url=${this.handleToolOpenUrl}
              @tool-install-extension=${this.handleToolInstallExtension}
              @tool-run-command=${this.handleToolRunCommand}
              @tool-recheck=${this.handleToolRecheck}
              @tool-toggle=${this.handleToolToggle}
              @bash-approval-toggle=${this.handleBashApprovalToggle}
              @desktop-crash-reporting-toggle=${
                this.handleDesktopCrashReportingToggle
              }
              @desktop-crash-reporting-dsn-set=${
                this.handleDesktopCrashReportingDsnSet
              }
            ></tools-tab>
          </wa-tab-panel>

          <wa-tab-panel name="ai-agents">
            <ai-agents-tab
              .items=${toolDashboardItems.get()}
              .loaded=${toolDashboardLoaded.get()}
              .codexSandboxMode=${codexSandboxMode.get()}
              .codexReasoningEffort=${codexReasoningEffort.get()}
              .codexApprovalPolicy=${codexApprovalPolicy.get()}
              .claudeAgentModel=${claudeAgentModel.get()}
              .claudeAgentPermissionMode=${claudeAgentPermissionMode.get()}
              .claudeAgentEffort=${claudeAgentEffort.get()}
              @tool-open-url=${this.handleToolOpenUrl}
              @tool-install-extension=${this.handleToolInstallExtension}
              @tool-run-command=${this.handleToolRunCommand}
              @tool-toggle=${this.handleToolToggle}
              @codex-sandbox-mode-change=${this.handleCodexSandboxModeChange}
              @codex-reasoning-effort-change=${
                this.handleCodexReasoningEffortChange
              }
              @codex-approval-policy-change=${
                this.handleCodexApprovalPolicyChange
              }
              @claude-agent-model-change=${this.handleClaudeAgentModelChange}
              @claude-agent-permission-mode-change=${
                this.handleClaudeAgentPermissionModeChange
              }
              @claude-agent-effort-change=${this.handleClaudeAgentEffortChange}
            ></ai-agents-tab>
          </wa-tab-panel>

          <wa-tab-panel name="git">
            <git-tab
              .markCommits=${gitMarkCommits.get()}
              .authorName=${gitAuthorName.get()}
              .authorEmail=${gitAuthorEmail.get()}
              .toggleDisabled=${!gitSettingsLoaded.get()}
              .unsupportedCommands=${unsupportedCommands.get()}
              @git-mark-commits-toggle=${this.handleGitMarkCommitsToggle}
              @git-author-name-change=${this.handleGitAuthorNameChange}
              @git-author-email-change=${this.handleGitAuthorEmailChange}
              @github-token-set=${this.handleGitHubTokenSet}
              @github-token-remove=${this.handleGitHubTokenRemove}
              @github-token-open-url=${this.handleGitHubTokenOpenUrl}
              @unsubscribe-pr=${this.handleUnsubscribePR}
              @open-pr-subscription-stream=${
                this.handleOpenPRSubscriptionStream
              }
              .githubTokenStatus=${githubTokenStatus.get()}
              .prSubscriptions=${prSubscriptions.get()}
            ></git-tab>
          </wa-tab-panel>

          <wa-tab-panel name="latex">
            <latex-tab
              .settings=${latexSettingsStatus.get()}
              .loaded=${latexSettingsLoaded.get()}
              .configValues=${latexConfigValues.get()}
              .configLoaded=${latexConfigValuesLoaded.get()}
              .inlineCriticismEnabled=${inlineCriticismEnabled.get()}
              .desktopHost=${desktopHost}
              .inlineCriticismSupported=${!isKnownUnsupported(
                unsupportedCommands.get(),
                SETTINGS_VIEW_COMMANDS.GET_INLINE_CRITICISM_ENABLED,
              )}
              @latex-apply-settings=${this.handleApplyLatexSettings}
              @latex-install-workshop=${this.handleInstallLatexWorkshop}
              @latex-run-install-command=${this.handleRunInstallCommand}
              @latex-set-config-value=${this.handleSetLatexConfigValue}
              @inline-criticism-toggle=${this.handleSetInlineCriticismEnabled}
            ></latex-tab>
          </wa-tab-panel>
        </wa-tab-group>
        ${this.renderProviderKeyModal()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-app': SettingsApp;
  }
}
