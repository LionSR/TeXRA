/**
 * SettingsApp component - main container for the unified settings view.
 * Combines Memory, History, and Account views into a tabbed interface.
 */

// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { customElement, query } from 'lit/decorators.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

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
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryMessageSchema,
  type MemoryViewItem,
  UpdateHistoryMessageSchema,
  HistoryClearedMessageSchema,
  type HistoryItem,
  UpdateProfileMessageSchema,
  type ProviderKeyStatus,
  type ModelSelectionItem,
  UpdateModelSelectionMessageSchema,
  SetTabMessageSchema,
} from '@shared/schemas';
import {
  UpdateAgentSelectionMessageSchema,
  UpdateCustomAgentDirMessageSchema,
  UpdateSuperYoloEnabledMessageSchema,
  UpdateAgentModePresetsMessageSchema,
  UpdateApprovalSettingsMessageSchema,
  UpdateToolDashboardMessageSchema,
  UpdateGitAuthorSettingsMessageSchema,
  UpdateGitHubTokenStatusMessageSchema,
  UpdatePRSubscriptionsMessageSchema,
  UpdateLatexSettingsStatusMessageSchema,
  type AgentSelectionItem,
  type NumberVscodeSetting,
  type ToolDashboardItem,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { NESTED_DELEGATION_DEPTH_RANGE } from '@shared/constants/delegationPolicy';

// Local imports - settings view
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import { settingsViewStyles } from './styles';
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
import type { HistoryTab } from './tabs/HistoryTab';

const HISTORY_ACTION_COMMANDS: Record<string, string> = {
  delete: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
  restore: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
  rerun: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
  'export-md': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_MD,
  'export-tex': SETTINGS_VIEW_COMMANDS.EXPORT_CHAT_TEX,
};

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

  // Agent mode presets state
  private readonly customPresets = signal<AgentModePreset[]>([]);

  // Super YOLO / reliability state
  private readonly superYoloEnabled = signal(false);
  private readonly superYoloToggleDisabled = signal(true);
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
  private readonly prSubscriptions = signal<readonly string[]>([]);

  // LaTeX settings state
  private readonly latexSettingsStatus = signal({
    ...DEFAULT_LATEX_SETTINGS_STATUS,
  });
  private readonly latexSettingsLoaded = signal(false);

  protected override get readyCommand(): string | null {
    return null;
  }

  /** Commands sent on load to populate all tabs with initial data. */
  private static readonly INIT_COMMANDS = [
    SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA,
    SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED,
    SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA,
    SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA,
    SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION,
    SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION,
    SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR,
    SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED,
    SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS,
    SETTINGS_VIEW_COMMANDS.GET_APPROVAL_SETTINGS,
    SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA,
    SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS,
    SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS,
  ] as const;

  override connectedCallback(): void {
    super.connectedCallback();
    for (const command of SettingsApp.INIT_COMMANDS) {
      postMessage(command);
    }
  }

  private parseMessage<T>(
    raw: unknown,
    schema: {
      safeParse(
        data: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
  ): T | null {
    const result = schema.safeParse(raw);
    if (!result.success) {
      this.logSchemaError(
        '[SettingsApp] Message validation failed.',
        result.error,
      );
      return null;
    }
    return result.data;
  }

  protected override handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('command' in raw)) {
      return;
    }

    const command = (raw as { command: string }).command;

    switch (command) {
      case SETTINGS_VIEW_COMMANDS.SET_TAB: {
        const data = this.parseMessage(raw, SetTabMessageSchema);
        if (!data) return;
        this.selectedTabIndex.set(data.tabIndex);
        this.agentSubTab.set(data.agentSubTab);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY: {
        const data = this.parseMessage(raw, UpdateMemoryMessageSchema);
        if (!data) return;
        this.memoryItems.set(data.items ?? []);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED: {
        const data = this.parseMessage(raw, UpdateMemoryEnabledMessageSchema);
        if (!data) return;
        this.memoryEnabled.set(data.enabled);
        this.memoryToggleDisabled.set(false);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY: {
        const data = this.parseMessage(raw, UpdateHistoryMessageSchema);
        if (!data) return;
        this.historyItems.set(
          [...data.historyItems].sort(
            (a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
          ),
        );
        return;
      }

      case SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED: {
        const data = this.parseMessage(raw, HistoryClearedMessageSchema);
        if (!data) return;
        this.historyItems.set([]);
        this.historyTab?.clearSearch();
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION: {
        const data = this.parseMessage(raw, UpdateModelSelectionMessageSchema);
        if (!data) return;
        this.modelSelectionItems.set(data.models);
        this.helperModel.set(data.helperModel);
        this.preferShortModelNames.set(data.preferShortModelNames);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION: {
        const data = this.parseMessage(raw, UpdateAgentSelectionMessageSchema);
        if (!data) return;
        this.workflowAgents.set(data.workflow);
        this.toolUseAgents.set(data.toolUse);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR: {
        const data = this.parseMessage(raw, UpdateCustomAgentDirMessageSchema);
        if (!data) return;
        this.customAgentDir.set(data.path);
        this.customAgentDirIsDefault.set(data.isDefault);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED: {
        const data = this.parseMessage(
          raw,
          UpdateSuperYoloEnabledMessageSchema,
        );
        if (!data) return;
        this.superYoloEnabled.set(data.enabled);
        this.superYoloToggleDisabled.set(false);
        this.reliabilitySettings.set(data.reliabilitySettings);
        this.allowOrchestratorKill.set(data.allowOrchestratorKill);
        this.detachSubagentsOnStop.set(data.detachSubagentsOnStop);
        this.nestedDelegationMaxDepth.set(data.nestedDelegationMaxDepth);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS: {
        const data = this.parseMessage(
          raw,
          UpdateAgentModePresetsMessageSchema,
        );
        if (!data) return;
        this.customPresets.set(data.customPresets);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS: {
        const data = this.parseMessage(
          raw,
          UpdateApprovalSettingsMessageSchema,
        );
        if (!data) return;
        this.bashApprovalEnabled.set(data.bashApprovalEnabled);
        this.codexSandboxMode.set(data.codexSandboxMode);
        this.codexReasoningEffort.set(data.codexReasoningEffort);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD: {
        const data = this.parseMessage(raw, UpdateToolDashboardMessageSchema);
        if (!data) return;
        this.toolDashboardItems.set(data.items);
        this.toolDashboardLoaded.set(true);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS: {
        const data = this.parseMessage(
          raw,
          UpdateGitAuthorSettingsMessageSchema,
        );
        if (!data) return;
        this.gitMarkCommits.set(data.markCommits);
        this.gitAuthorName.set(data.authorName);
        this.gitAuthorEmail.set(data.authorEmail);
        this.gitWorktreeSupport.set(data.worktreeSupport);
        this.gitSettingsLoaded.set(true);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS: {
        const data = this.parseMessage(
          raw,
          UpdateGitHubTokenStatusMessageSchema,
        );
        if (!data) return;
        this.githubTokenStatus.set(data.status);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS: {
        const data = this.parseMessage(raw, UpdatePRSubscriptionsMessageSchema);
        if (!data) return;
        this.prSubscriptions.set(data.keys);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS: {
        const data = this.parseMessage(
          raw,
          UpdateLatexSettingsStatusMessageSchema,
        );
        if (!data) return;
        this.latexSettingsStatus.set(data.settings);
        this.latexSettingsLoaded.set(true);
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE: {
        const data = this.parseMessage(raw, UpdateProfileMessageSchema);
        if (!data) return;
        this.authenticated.set(data.authenticated);
        this.userEmail.set(data.user?.email ?? 'N/A');
        this.userId.set(data.user?.id ?? '');
        this.tier.set(data.tier ?? 'free');
        this.apiAccessMode.set(data.apiAccessMode);
        this.allowedModels.set(data.allowedModels ?? null);
        this.accessExpiresAt.set(data.accessExpiresAt ?? null);
        this.providerKeyStatuses.set(data.providerKeyStatuses ?? []);
        this.globalStreamingDefault.set(data.globalStreamingDefault ?? true);
        return;
      }
    }
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

  private handleSetProviderKey = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY,
  );

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

  private handleSuperYoloToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED,
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

  // LaTeX settings event handlers
  private handleApplyLatexSettings = forwardDetail(
    SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS,
  );

  private handleInstallLatexWorkshop = forwardCommand(
    SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP,
  );

  private handleRunInstallCommand = forwardDetail(
    SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
  );

  private handleOpenVscodeSettings = forwardCommand(
    SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS,
  );

  private renderHeader(): TemplateResult {
    const settingsButton = html`
      <vscode-toolbar-button
        icon="settings-gear"
        title="Open VS Code Settings"
        @click=${this.handleOpenVscodeSettings}
      ></vscode-toolbar-button>
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
            <vscode-toolbar-button
              icon="sign-out"
              label="Sign Out"
              title="Sign out"
              @click=${this.handleSignOut}
            ></vscode-toolbar-button>
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
          <vscode-toolbar-button
            icon="sign-in"
            label="Sign In"
            title="Sign in"
            @click=${this.handleSignIn}
          ></vscode-toolbar-button>
        </div>
      </div>
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
              .superYoloEnabled=${this.superYoloEnabled.get()}
              .toggleDisabled=${this.superYoloToggleDisabled.get()}
              .reliabilitySettings=${this.reliabilitySettings.get()}
              .customPresets=${this.customPresets.get()}
              .allowOrchestratorKill=${this.allowOrchestratorKill.get()}
              .detachSubagentsOnStop=${this.detachSubagentsOnStop.get()}
              .worktreeSupport=${this.gitWorktreeSupport.get()}
              .nestedDelegationMaxDepth=${this.nestedDelegationMaxDepth.get()}
              @super-yolo-toggle=${this.handleSuperYoloToggle}
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
              @tool-open-url=${this.handleToolOpenUrl}
              @tool-install-extension=${this.handleToolInstallExtension}
              @tool-run-command=${this.handleToolRunCommand}
              @tool-recheck=${this.handleToolRecheck}
              @tool-toggle=${this.handleToolToggle}
              @bash-approval-toggle=${this.handleBashApprovalToggle}
              @codex-sandbox-mode-change=${this.handleCodexSandboxModeChange}
              @codex-reasoning-effort-change=${this
                .handleCodexReasoningEffortChange}
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
              .githubTokenStatus=${this.githubTokenStatus.get()}
              .prSubscriptions=${this.prSubscriptions.get()}
            ></git-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <latex-tab
              .settings=${this.latexSettingsStatus.get()}
              .loaded=${this.latexSettingsLoaded.get()}
              @latex-apply-settings=${this.handleApplyLatexSettings}
              @latex-install-workshop=${this.handleInstallLatexWorkshop}
              @latex-run-install-command=${this.handleRunInstallCommand}
            ></latex-tab>
          </vscode-tab-panel>
        </vscode-tabs>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-app': SettingsApp;
  }
}
