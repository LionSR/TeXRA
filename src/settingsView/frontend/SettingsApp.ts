/**
 * SettingsApp component - main container for the unified settings view.
 * Combines Memory, History, and Account views into a tabbed interface.
 */

// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

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
  UpdateToolDashboardMessageSchema,
  UpdateLatexSettingsStatusMessageSchema,
  type AgentSelectionItem,
  type NumberVscodeSetting,
  type ToolDashboardItem,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

// Local imports - settings view commands
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - settings view styles
import { settingsViewStyles } from './styles';
import type { VscTabsSelectEvent } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js';

// Local imports - shared schema types
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';

// Local imports - settings view tabs (side-effect: register)
import './tabs/MemoryTab';
import './tabs/HistoryTab';
import './tabs/ModelsTab';
import './tabs/AgentsTab';
import './tabs/MultiAgentTab';
import './tabs/ToolsTab';
import './tabs/LaTeXTab';
import type { HistoryTab } from './tabs/HistoryTab';

const HISTORY_ACTION_COMMANDS: Record<string, string> = {
  delete: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
  restore: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
  rerun: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
};

/** Create an event handler that forwards event.detail to a postMessage command. */
function forwardDetail<T extends Record<string, unknown>>(
  command: string,
): (event: CustomEvent<T>) => void {
  return (event: CustomEvent<T>) => postMessage(command, event.detail);
}

@customElement('settings-app')
export class SettingsApp extends BaseWebviewApp {
  static override styles = [
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
  @state() private selectedTabIndex = 0;

  // Memory state
  @state() private memoryItems: MemoryViewItem[] = [];
  @state() private memoryEnabled = false;
  @state() private memoryToggleDisabled = true;

  // History state
  @state() private historyItems: HistoryItem[] = [];

  // Profile state
  @state() private authenticated = false;
  @state() private userEmail = '';
  @state() private userId = '';
  @state() private tier = 'free';
  @state() private apiAccessMode: 'included' | 'personal' = 'personal';
  @state() private allowedModels: string[] | null = [];
  @state() private accessExpiresAt: string | null = null;
  @state() private providerKeyStatuses: ProviderKeyStatus[] = [];
  @state() private globalStreamingDefault = true;

  // Model selection state
  @state() private modelSelectionItems: ModelSelectionItem[] = [];
  @state() private helperModel = DEFAULT_HELPER_MODEL;

  // Agent selection state
  @state() private workflowAgents: AgentSelectionItem[] = [];
  @state() private toolUseAgents: AgentSelectionItem[] = [];
  @state() private customAgentDir = '';
  @state() private customAgentDirIsDefault = true;
  @state() private agentSubTab: AgentCategory | undefined;

  // Agent mode presets state
  @state() private customPresets: AgentModePreset[] = [];

  // Super YOLO / reliability state
  @state() private superYoloEnabled = false;
  @state() private superYoloToggleDisabled = true;
  @state() private reliabilitySettings: NumberVscodeSetting[] = [];
  @state() private allowOrchestratorKill = true;

  // Tool dashboard state
  @state() private toolDashboardItems: ToolDashboardItem[] = [];
  @state() private toolDashboardLoaded = false;

  // LaTeX settings state
  @state() private latexSettingsStatus = { ...DEFAULT_LATEX_SETTINGS_STATUS };
  @state() private latexSettingsLoaded = false;

  protected override get readyCommand(): string | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Request all data on load
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MODEL_SELECTION);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_AGENT_SELECTION);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_CUSTOM_AGENT_DIR);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_SUPER_YOLO_ENABLED);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_AGENT_MODE_PRESETS);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_TOOL_DASHBOARD_DATA);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_LATEX_SETTINGS_STATUS);
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
        this.selectedTabIndex = data.tabIndex;
        this.agentSubTab = data.agentSubTab;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY: {
        const data = this.parseMessage(raw, UpdateMemoryMessageSchema);
        if (!data) return;
        this.memoryItems = data.items ?? [];
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED: {
        const data = this.parseMessage(raw, UpdateMemoryEnabledMessageSchema);
        if (!data) return;
        this.memoryEnabled = data.enabled;
        this.memoryToggleDisabled = false;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY: {
        const data = this.parseMessage(raw, UpdateHistoryMessageSchema);
        if (!data) return;
        this.historyItems = [...data.historyItems].sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
        return;
      }

      case SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED: {
        const data = this.parseMessage(raw, HistoryClearedMessageSchema);
        if (!data) return;
        this.historyItems = [];
        this.historyTab?.clearSearch();
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION: {
        const data = this.parseMessage(raw, UpdateModelSelectionMessageSchema);
        if (!data) return;
        this.modelSelectionItems = data.models;
        this.helperModel = data.helperModel;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION: {
        const data = this.parseMessage(raw, UpdateAgentSelectionMessageSchema);
        if (!data) return;
        this.workflowAgents = data.workflow;
        this.toolUseAgents = data.toolUse;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR: {
        const data = this.parseMessage(raw, UpdateCustomAgentDirMessageSchema);
        if (!data) return;
        this.customAgentDir = data.path;
        this.customAgentDirIsDefault = data.isDefault;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED: {
        const data = this.parseMessage(
          raw,
          UpdateSuperYoloEnabledMessageSchema,
        );
        if (!data) return;
        this.superYoloEnabled = data.enabled;
        this.superYoloToggleDisabled = false;
        this.reliabilitySettings = data.reliabilitySettings;
        this.allowOrchestratorKill = data.allowOrchestratorKill;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS: {
        const data = this.parseMessage(
          raw,
          UpdateAgentModePresetsMessageSchema,
        );
        if (!data) return;
        this.customPresets = data.customPresets;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD: {
        const data = this.parseMessage(raw, UpdateToolDashboardMessageSchema);
        if (!data) return;
        this.toolDashboardItems = data.items;
        this.toolDashboardLoaded = true;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS: {
        const data = this.parseMessage(
          raw,
          UpdateLatexSettingsStatusMessageSchema,
        );
        if (!data) return;
        this.latexSettingsStatus = data.settings;
        this.latexSettingsLoaded = true;
        return;
      }

      case SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE: {
        const data = this.parseMessage(raw, UpdateProfileMessageSchema);
        if (!data) return;
        this.authenticated = data.authenticated;
        this.userEmail = data.user?.email ?? 'N/A';
        this.userId = data.user?.id ?? '';
        this.tier = data.tier ?? 'free';
        this.apiAccessMode = data.apiAccessMode;
        this.allowedModels = data.allowedModels ?? null;
        this.accessExpiresAt = data.accessExpiresAt ?? null;
        this.providerKeyStatuses = data.providerKeyStatuses ?? [];
        this.globalStreamingDefault = data.globalStreamingDefault ?? true;
        return;
      }
    }
  }

  // Tab event handler
  private handleTabSelect(event: VscTabsSelectEvent): void {
    this.selectedTabIndex = event.detail.selectedIndex;
  }

  // Memory event handlers
  private handleMemoryRefresh(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA);
  }

  private handleMemoryOpenFolder(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER);
  }

  private handleMemoryToggleEnabled = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED,
  );

  private handleMemoryOpenItem = forwardDetail(
    SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE,
  );

  private handleMemoryDeleteItem(
    event: CustomEvent<{ storagePath: string; displayPath?: string }>,
  ): void {
    postMessage(SETTINGS_VIEW_COMMANDS.DELETE_MEMORY, {
      storagePath: event.detail.storagePath,
      displayPath: event.detail.displayPath ?? event.detail.storagePath,
    });
  }

  // History event handlers
  private handleHistoryAction(
    event: CustomEvent<{ action: string; historyId: string }>,
  ): void {
    const command = HISTORY_ACTION_COMMANDS[event.detail.action];
    if (!command) return;
    postMessage(command, { historyId: event.detail.historyId });
  }

  private handleClearHistory(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY);
  }

  // Profile event handlers
  private handleSignIn(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_IN);
  }

  private handleSignOut(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_OUT);
  }

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

  private handleSetCustomAgentDir(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR);
  }

  private handleResetCustomAgentDir(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR);
  }

  private handleRevealAgentFile = forwardDetail(
    SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE,
  );

  private handleSuperYoloToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_SUPER_YOLO_ENABLED,
  );

  private handleAllowOrchestratorKillToggle = forwardDetail(
    SETTINGS_VIEW_COMMANDS.SET_ALLOW_ORCHESTRATOR_KILL,
  );

  private handleApplyAgentModePreset = forwardDetail(
    SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET,
  );

  private handleSaveAgentModePreset(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET);
  }

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

  private handleToolRecheck(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS);
  }

  // LaTeX settings event handlers
  private handleApplyLatexSettings = forwardDetail(
    SETTINGS_VIEW_COMMANDS.APPLY_LATEX_SETTINGS,
  );

  private handleInstallLatexWorkshop(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.INSTALL_LATEX_WORKSHOP);
  }

  private handleRunInstallCommand = forwardDetail(
    SETTINGS_VIEW_COMMANDS.RUN_INSTALL_COMMAND,
  );

  private handleOpenVscodeSettings(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS);
  }

  private renderHeader(): TemplateResult {
    const settingsButton = html`
      <vscode-toolbar-button
        icon="settings-gear"
        title="Open VS Code Settings"
        @click=${this.handleOpenVscodeSettings}
      ></vscode-toolbar-button>
    `;

    if (this.authenticated) {
      return html`
        <div class="settings-header">
          <div class="settings-header-user">
            <span class="codicon codicon-account"></span>
            <div class="settings-header-info">
              <span class="settings-header-email">${this.userEmail}</span>
              <span class="settings-header-tier">${this.tier} Plan</span>
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
          .selectedIndex=${this.selectedTabIndex}
          @vsc-tabs-select=${this.handleTabSelect}
        >
          <vscode-tab-header slot="header"><span class="codicon codicon-database"></span> Memory</vscode-tab-header>
          <vscode-tab-header slot="header"><span class="codicon codicon-history"></span> History</vscode-tab-header>
          <vscode-tab-header slot="header"><span class="codicon codicon-server"></span> Models</vscode-tab-header>
          <vscode-tab-header slot="header"><span class="codicon codicon-robot"></span> Agents</vscode-tab-header>
          <vscode-tab-header slot="header"><span class="codicon codicon-organization"></span> Multi-Agent</vscode-tab-header>
          <vscode-tab-header slot="header"><span class="codicon codicon-tools"></span> Tools</vscode-tab-header>
          <vscode-tab-header slot="header"><span class="codicon codicon-file-code"></span> LaTeX</vscode-tab-header>

          <vscode-tab-panel>
            <memory-tab
              .items=${this.memoryItems}
              .enabled=${this.memoryEnabled}
              .toggleDisabled=${this.memoryToggleDisabled}
              @memory-refresh=${this.handleMemoryRefresh}
              @memory-open-folder=${this.handleMemoryOpenFolder}
              @memory-toggle-enabled=${this.handleMemoryToggleEnabled}
              @memory-open-item=${this.handleMemoryOpenItem}
              @memory-delete-item=${this.handleMemoryDeleteItem}
            ></memory-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <history-tab
              .items=${this.historyItems}
              @history-action=${this.handleHistoryAction}
              @history-clear=${this.handleClearHistory}
            ></history-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <models-tab
              .authenticated=${this.authenticated}
              .apiAccessMode=${this.apiAccessMode}
              .allowedModels=${this.allowedModels}
              .providerKeyStatuses=${this.providerKeyStatuses}
              .globalStreamingDefault=${this.globalStreamingDefault}
              .modelSelectionItems=${this.modelSelectionItems}
              .helperModel=${this.helperModel}
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
            ></models-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <agents-tab
              .workflowAgents=${this.workflowAgents}
              .toolUseAgents=${this.toolUseAgents}
              .customAgentDir=${this.customAgentDir}
              .customAgentDirIsDefault=${this.customAgentDirIsDefault}
              .initialSubTab=${this.agentSubTab}
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
            ></agents-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <multi-agent-tab
              .superYoloEnabled=${this.superYoloEnabled}
              .toggleDisabled=${this.superYoloToggleDisabled}
              .reliabilitySettings=${this.reliabilitySettings}
              .customPresets=${this.customPresets}
              .allowOrchestratorKill=${this.allowOrchestratorKill}
              @super-yolo-toggle=${this.handleSuperYoloToggle}
              @allow-orchestrator-kill-toggle=${this
                .handleAllowOrchestratorKillToggle}
              @reliability-setting-change=${this.handleSetProviderVscodeSetting}
              @apply-agent-mode-preset=${this.handleApplyAgentModePreset}
              @delete-agent-mode-preset=${this.handleDeleteAgentModePreset}
            ></multi-agent-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <tools-tab
              .items=${this.toolDashboardItems}
              .loaded=${this.toolDashboardLoaded}
              @tool-open-url=${this.handleToolOpenUrl}
              @tool-install-extension=${this.handleToolInstallExtension}
              @tool-recheck=${this.handleToolRecheck}
            ></tools-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <latex-tab
              .settings=${this.latexSettingsStatus}
              .loaded=${this.latexSettingsLoaded}
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
