/**
 * SettingsApp component - main container for the unified settings view.
 * Combines Memory, History, and Account views into a tabbed interface.
 */

// Third-party imports
import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/hostBridge';

// Local imports - shared signals
import { SignalWatcher, signal } from '@shared/signals';

// Local imports - shared styles
import {
  badgeStyles,
  codiconStyles,
  commonViewStyles,
  designTokens,
} from '@shared/styles';

// Local imports - shared schemas and constants
import {
  type MemoryViewItem,
  type HistoryItem,
  type ProviderKeyStatus,
  type ModelSelectionItem,
  SETTINGS_TAB,
} from '@shared/schemas';
import {
  type AgentSelectionItem,
  type LatexConfigValues,
  type NumberVscodeSetting,
  type PRSubscriptionEntry,
  type ToolDashboardItem,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import {
  DEFAULT_HELPER_MODEL,
  PROVIDER_DISPLAY_NAMES,
} from '@shared/constants/providers';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/apiKeyProviders';
import { NESTED_DELEGATION_DEPTH_RANGE } from '@shared/constants/delegationPolicy';

// Local imports - settings view
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import { settingsViewStyles } from './styles';
import {
  dispatchSettingsViewMessage,
  type SettingsMessageHandlerContext,
} from './settingsViewDispatcher';
import type { VscTabsSelectEvent } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js';

// Side-effect: register tab components
import './tabs/MemoryTab';
import './tabs/HistoryTab';
import './tabs/ModelsTab';
import './tabs/AgentsTab';
import './tabs/MultiAgentTab';
import './tabs/ToolsTab';
import './tabs/GitTab';
import './tabs/LaTeXTab';
import './components/profile/ProviderKeyModal';
import type { HistoryTab } from './tabs/HistoryTab';

const HISTORY_ACTION_COMMANDS: Record<string, string> = {
  delete: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
  restore: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
  rerun: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
  'export-md': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
  'export-tex': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
};

const API_KEY_PROVIDER_SET = new Set<string>(API_KEY_PROVIDER_IDS);

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
  static styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    ...badgeStyles,
    settingsViewStyles,
    css`
      :host {
        display: block;
        height: 100%;
      }

      .settings-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      vscode-tabs {
        flex: 1;
        display: flex;
        flex-direction: column;
      }

      vscode-tab-panel {
        flex: 1;
        overflow: auto;
        padding: var(--spacing-large);
      }
    `,
  ];

  // Tab refs
  @query('history-tab') private historyTab?: HistoryTab;

  // Tab state
  private readonly selectedTabIndex = signal(0);

  // Memory state
  private readonly memoryItems = signal<MemoryViewItem[]>([]);
  private readonly memoryEnabled = signal(false);
  private readonly memoryToggleDisabled = signal(true);

  // History state
  private readonly historyItems = signal<HistoryItem[]>([]);

  // Profile state
  private readonly authenticated = signal(false);
  private readonly userEmail = signal('');
  private readonly userId = signal('');
  private readonly tier = signal('free');
  private readonly apiAccessMode = signal<'included' | 'personal'>('personal');
  private readonly allowedModels = signal<string[] | null>([]);
  private readonly accessExpiresAt = signal<string | null>(null);
  private readonly providerKeyStatuses = signal<ProviderKeyStatus[]>([]);
  private readonly globalStreamingDefault = signal(true);
  private readonly providerKeyModal = signal<{
    provider: string;
    displayName: string;
  } | null>(null);

  // Model selection state
  private readonly modelSelectionItems = signal<ModelSelectionItem[]>([]);
  private readonly helperModel = signal(DEFAULT_HELPER_MODEL);
  private readonly preferShortModelNames = signal(false);

  // Agent selection state
  private readonly workflowAgents = signal<AgentSelectionItem[]>([]);
  private readonly toolUseAgents = signal<AgentSelectionItem[]>([]);
  private readonly customAgentDir = signal('');
  private readonly customAgentDirIsDefault = signal(true);
  private readonly agentSubTab = signal<AgentCategory | undefined>(undefined);

  // Agent teams state
  private readonly customPresets = signal<AgentModePreset[]>([]);

  // Multi-agent coordination / reliability state
  private readonly reliabilitySettings = signal<NumberVscodeSetting[]>([]);
  private readonly allowOrchestratorKill = signal(true);
  private readonly detachSubagentsOnStop = signal(false);
  private readonly nestedDelegationMaxDepth = signal<number>(
    NESTED_DELEGATION_DEPTH_RANGE.default,
  );

  // Approval settings state
  private readonly bashApprovalEnabled = signal(true);
  private readonly codexSandboxMode = signal<string>('workspace-write');
  private readonly codexReasoningEffort = signal<string>('high');
  private readonly codexApprovalPolicy = signal<string>('never');

  // Tool dashboard state
  private readonly toolDashboardItems = signal<ToolDashboardItem[]>([]);
  private readonly toolDashboardLoaded = signal(false);

  // Git author settings state
  private readonly gitMarkCommits = signal(DEFAULT_GIT_MARK_COMMITS);
  private readonly gitAuthorName = signal(DEFAULT_GIT_AUTHOR_NAME);
  private readonly gitAuthorEmail = signal(DEFAULT_GIT_AUTHOR_EMAIL);
  private readonly gitWorktreeSupport = signal(false);
  private readonly gitSettingsLoaded = signal(false);
  private readonly githubTokenStatus = signal<'secret' | 'env' | 'none'>(
    'none',
  );
  private readonly prSubscriptions = signal<readonly PRSubscriptionEntry[]>([]);

  // LaTeX settings state
  private readonly latexSettingsStatus = signal({
    ...DEFAULT_LATEX_SETTINGS_STATUS,
  });
  private readonly latexSettingsLoaded = signal(false);
  private readonly latexConfigValues = signal<LatexConfigValues>({});
  private readonly latexConfigValuesLoaded = signal(false);

  private getMessageHandlerContext(): SettingsMessageHandlerContext {
    return {
      selectedTabIndex: this.selectedTabIndex,
      memoryItems: this.memoryItems,
      memoryEnabled: this.memoryEnabled,
      memoryToggleDisabled: this.memoryToggleDisabled,
      historyItems: this.historyItems,
      authenticated: this.authenticated,
      userEmail: this.userEmail,
      userId: this.userId,
      tier: this.tier,
      apiAccessMode: this.apiAccessMode,
      allowedModels: this.allowedModels,
      accessExpiresAt: this.accessExpiresAt,
      providerKeyStatuses: this.providerKeyStatuses,
      globalStreamingDefault: this.globalStreamingDefault,
      modelSelectionItems: this.modelSelectionItems,
      helperModel: this.helperModel,
      preferShortModelNames: this.preferShortModelNames,
      workflowAgents: this.workflowAgents,
      toolUseAgents: this.toolUseAgents,
      customAgentDir: this.customAgentDir,
      customAgentDirIsDefault: this.customAgentDirIsDefault,
      agentSubTab: this.agentSubTab,
      customPresets: this.customPresets,
      reliabilitySettings: this.reliabilitySettings,
      allowOrchestratorKill: this.allowOrchestratorKill,
      detachSubagentsOnStop: this.detachSubagentsOnStop,
      nestedDelegationMaxDepth: this.nestedDelegationMaxDepth,
      bashApprovalEnabled: this.bashApprovalEnabled,
      codexSandboxMode: this.codexSandboxMode,
      codexReasoningEffort: this.codexReasoningEffort,
      codexApprovalPolicy: this.codexApprovalPolicy,
      toolDashboardItems: this.toolDashboardItems,
      toolDashboardLoaded: this.toolDashboardLoaded,
      gitMarkCommits: this.gitMarkCommits,
      gitAuthorName: this.gitAuthorName,
      gitAuthorEmail: this.gitAuthorEmail,
      gitWorktreeSupport: this.gitWorktreeSupport,
      gitSettingsLoaded: this.gitSettingsLoaded,
      githubTokenStatus: this.githubTokenStatus,
      prSubscriptions: this.prSubscriptions,
      latexSettingsStatus: this.latexSettingsStatus,
      latexSettingsLoaded: this.latexSettingsLoaded,
      latexConfigValues: this.latexConfigValues,
      latexConfigValuesLoaded: this.latexConfigValuesLoaded,
      clearHistorySearch: () => this.historyTab?.clearSearch(),
      logSchemaError: (message, error) => this.logSchemaError(message, error),
    };
  }

  protected override handleMessage(raw: unknown): void {
    dispatchSettingsViewMessage(raw, this.getMessageHandlerContext());
  }

  private handleTabSelect(event: VscTabsSelectEvent): void {
    this.selectedTabIndex.set(event.detail.selectedIndex);
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

  private isDesktopHost(): boolean {
    return (
      this.getAttribute('data-desktop-view') === 'settings' ||
      Object.hasOwn(window, 'texraDesktop')
    );
  }

  private handleSetProviderKey(event: CustomEvent<{ provider: string }>): void {
    if (!this.isDesktopHost()) {
      postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, event.detail);
      return;
    }

    const status = this.providerKeyStatuses
      .get()
      .find((entry) => entry.provider === event.detail.provider);
    this.providerKeyModal.set({
      provider: event.detail.provider,
      displayName: status?.displayName ?? event.detail.provider,
    });
  }

  private handleProviderKeySubmit(
    event: CustomEvent<{ provider: string; apiKey: string }>,
  ): void {
    this.providerKeyModal.set(null);
    postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, event.detail);
  }

  private readonly handleProviderKeyCancel = (): void => {
    this.providerKeyModal.set(null);
  };

  private getDefaultProviderKeyTarget(): {
    provider: string;
    displayName: string;
  } {
    const helperProvider = this.modelSelectionItems
      .get()
      .find((model) => model.name === this.helperModel.get())?.provider;
    const providerKeyStatuses = this.providerKeyStatuses.get();
    const fallbackProvider =
      providerKeyStatuses.find((entry) => entry.status === 'not-set')
        ?.provider ?? API_KEY_PROVIDER_IDS[0];
    const provider =
      helperProvider && API_KEY_PROVIDER_SET.has(helperProvider)
        ? helperProvider
        : fallbackProvider;
    const status = providerKeyStatuses.find(
      (entry) => entry.provider === provider,
    );
    return {
      provider,
      displayName:
        status?.displayName ?? PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    };
  }

  private readonly handleSetDefaultProviderKey = (): void => {
    const target = this.getDefaultProviderKeyTarget();
    this.selectedTabIndex.set(SETTINGS_TAB.MODELS);

    if (!this.isDesktopHost()) {
      postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, {
        provider: target.provider,
      });
      return;
    }

    this.providerKeyModal.set(target);
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

  private handleNestedDelegationMaxDepthChange = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_NESTED_DELEGATION_MAX_DEPTH,
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

  private handleRunInstallCommand = forwardDetail(
    SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
  );

  private handleOpenVscodeSettings = forwardCommand(
    SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
  );

  private renderHeader(): TemplateResult {
    const settingsButton = html`
      <wa-button
        appearance="plain"
        size="s"
        title="Open VS Code Settings"
        @click=${this.handleOpenVscodeSettings}
      >
        <wa-icon library="system" name="gear" variant="solid"></wa-icon>
      </wa-button>
    `;

    if (this.authenticated.get()) {
      return html`
        <div class="settings-header">
          <div class="settings-header-user">
            <span class="codicon codicon-account"></span>
            <div class="settings-header-info">
              <span class="settings-header-email">${this.userEmail.get()}</span>
              <span class="settings-header-tier">${this.tier.get()} Plan</span>
            </div>
          </div>
          <div class="settings-header-actions">
            ${settingsButton}
            <wa-button
              class="settings-header-auth-button"
              appearance="outlined"
              variant="neutral"
              size="s"
              title="Sign out"
              @click=${this.handleSignOut}
            >
              <wa-icon
                slot="start"
                library="system"
                name="xmark"
                variant="solid"
              ></wa-icon>
              Sign out
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
            size="s"
            title="Set provider API key"
            @click=${this.handleSetDefaultProviderKey}
          >
            <wa-icon
              slot="start"
              library="system"
              name="gear"
              variant="solid"
            ></wa-icon>
            Set API key
          </wa-button>
          <wa-button
            class="settings-header-auth-button"
            appearance="filled"
            variant="brand"
            size="s"
            title="Sign in"
            @click=${this.handleSignIn}
          >
            <wa-icon
              slot="start"
              library="system"
              name="user"
              variant="solid"
            ></wa-icon>
            Sign in
          </wa-button>
        </div>
      </div>
    `;
  }

  private renderProviderKeyModal(): TemplateResult | typeof nothing {
    const modal = this.providerKeyModal.get();
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

  override render(): TemplateResult {
    return html`
      <div class="settings-container">
        ${this.renderHeader()}

        <vscode-tabs
          .selectedIndex=${this.selectedTabIndex.get()}
          @vsc-tabs-select=${this.handleTabSelect}
        >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-database"></span>
            Memory</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-history"></span>
            History</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-server"></span>
            Models</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-robot"></span>
            Agents</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-organization"></span>
            Multi-Agent</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-tools"></span>
            Tools</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-git-commit"></span>
            Git</vscode-tab-header
          >
          <vscode-tab-header slot="header"
            ><span class="codicon codicon-file-code"></span>
            LaTeX</vscode-tab-header
          >

          <vscode-tab-panel>
            <memory-tab
              .items=${this.memoryItems.get()}
              .enabled=${this.memoryEnabled.get()}
              .toggleDisabled=${this.memoryToggleDisabled.get()}
              @memory-refresh=${this.handleMemoryRefresh}
              @memory-open-folder=${this.handleMemoryOpenFolder}
              @memory-toggle-enabled=${this.handleMemoryToggleEnabled}
              @memory-open-item=${this.handleMemoryOpenItem}
              @memory-delete-item=${this.handleMemoryDeleteItem}
              @memory-pin-item=${this.handleMemoryPinItem}
              @memory-unpin-item=${this.handleMemoryUnpinItem}
            ></memory-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <history-tab
              .items=${this.historyItems.get()}
              @history-action=${this.handleHistoryAction}
              @history-clear=${this.handleClearHistory}
            ></history-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <models-tab
              .authenticated=${this.authenticated.get()}
              .apiAccessMode=${this.apiAccessMode.get()}
              .allowedModels=${this.allowedModels.get()}
              .providerKeyStatuses=${this.providerKeyStatuses.get()}
              .globalStreamingDefault=${this.globalStreamingDefault.get()}
              .modelSelectionItems=${this.modelSelectionItems.get()}
              .helperModel=${this.helperModel.get()}
              .preferShortModelNames=${this.preferShortModelNames.get()}
              @profile-api-access-mode=${this.handleApiAccessMode}
              @provider-key-set=${this.handleSetProviderKey}
              @provider-key-remove=${this.handleRemoveProviderKey}
              @provider-key-open-url=${this.handleOpenProviderKeyUrl}
              @provider-streaming-set=${this.handleSetProviderStreaming}
              @provider-endpoint-set=${this.handleSetProviderEndpoint}
              @provider-global-streaming-set=${this.handleSetGlobalStreaming}
              @provider-vscode-setting-set=${this
                .handleSetProviderVscodeSetting}
              @provider-open-url=${this.handleOpenUrl}
              @model-enabled-set=${this.handleSetModelEnabled}
              @helper-model-set=${this.handleSetHelperModel}
              @model-reasoning-level-set=${this.handleSetReasoningLevel}
              @prefer-short-model-names-set=${this
                .handleSetPreferShortModelNames}
            ></models-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <agents-tab
              .workflowAgents=${this.workflowAgents.get()}
              .toolUseAgents=${this.toolUseAgents.get()}
              .customAgentDir=${this.customAgentDir.get()}
              .customAgentDirIsDefault=${this.customAgentDirIsDefault.get()}
              .initialSubTab=${this.agentSubTab.get()}
              .userTier=${this.tier.get()}
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
          </vscode-tab-panel>

          <vscode-tab-panel>
            <multi-agent-tab
              .reliabilitySettings=${this.reliabilitySettings.get()}
              .customPresets=${this.customPresets.get()}
              .allowOrchestratorKill=${this.allowOrchestratorKill.get()}
              .detachSubagentsOnStop=${this.detachSubagentsOnStop.get()}
              .worktreeSupport=${this.gitWorktreeSupport.get()}
              .nestedDelegationMaxDepth=${this.nestedDelegationMaxDepth.get()}
              @allow-orchestrator-kill-toggle=${this
                .handleAllowOrchestratorKillToggle}
              @detach-subagents-on-stop-toggle=${this
                .handleDetachSubagentsOnStopToggle}
              @worktree-support-toggle=${this.handleWorktreeSupportToggle}
              @nested-delegation-max-depth-change=${this
                .handleNestedDelegationMaxDepthChange}
              @reliability-setting-change=${this.handleSetProviderVscodeSetting}
              @apply-agent-mode-preset=${this.handleApplyAgentModePreset}
              @delete-agent-mode-preset=${this.handleDeleteAgentModePreset}
            ></multi-agent-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <tools-tab
              .items=${this.toolDashboardItems.get()}
              .loaded=${this.toolDashboardLoaded.get()}
              .bashApprovalEnabled=${this.bashApprovalEnabled.get()}
              .codexSandboxMode=${this.codexSandboxMode.get()}
              .codexReasoningEffort=${this.codexReasoningEffort.get()}
              .codexApprovalPolicy=${this.codexApprovalPolicy.get()}
              @tool-open-url=${this.handleToolOpenUrl}
              @tool-install-extension=${this.handleToolInstallExtension}
              @tool-run-command=${this.handleToolRunCommand}
              @tool-recheck=${this.handleToolRecheck}
              @tool-toggle=${this.handleToolToggle}
              @bash-approval-toggle=${this.handleBashApprovalToggle}
              @codex-sandbox-mode-change=${this.handleCodexSandboxModeChange}
              @codex-reasoning-effort-change=${this
                .handleCodexReasoningEffortChange}
              @codex-approval-policy-change=${this
                .handleCodexApprovalPolicyChange}
            ></tools-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <git-tab
              .markCommits=${this.gitMarkCommits.get()}
              .authorName=${this.gitAuthorName.get()}
              .authorEmail=${this.gitAuthorEmail.get()}
              .toggleDisabled=${!this.gitSettingsLoaded.get()}
              @git-mark-commits-toggle=${this.handleGitMarkCommitsToggle}
              @git-author-name-change=${this.handleGitAuthorNameChange}
              @git-author-email-change=${this.handleGitAuthorEmailChange}
              @github-token-set=${this.handleGitHubTokenSet}
              @github-token-remove=${this.handleGitHubTokenRemove}
              @github-token-open-url=${this.handleGitHubTokenOpenUrl}
              @unsubscribe-pr=${this.handleUnsubscribePR}
              @open-pr-subscription-stream=${this
                .handleOpenPRSubscriptionStream}
              .githubTokenStatus=${this.githubTokenStatus.get()}
              .prSubscriptions=${this.prSubscriptions.get()}
            ></git-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <latex-tab
              .settings=${this.latexSettingsStatus.get()}
              .loaded=${this.latexSettingsLoaded.get()}
              .configValues=${this.latexConfigValues.get()}
              .configLoaded=${this.latexConfigValuesLoaded.get()}
              @latex-apply-settings=${this.handleApplyLatexSettings}
              @latex-install-workshop=${this.handleInstallLatexWorkshop}
              @latex-run-install-command=${this.handleRunInstallCommand}
              @latex-set-config-value=${this.handleSetLatexConfigValue}
            ></latex-tab>
          </vscode-tab-panel>
        </vscode-tabs>
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
