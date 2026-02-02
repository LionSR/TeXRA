/**
 * SettingsApp component - main container for the unified settings view.
 * Combines Memory, History, and Account views into a tabbed interface.
 */

// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { VscTabsSelectEvent } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js';

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

// Local imports - shared schemas
import {
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryMessageSchema,
  type MemoryViewItem,
  UpdateHistoryMessageSchema,
  HistoryClearedMessageSchema,
  type HistoryItem,
  UpdateProfileMessageSchema,
  type RemoteAgent,
} from '@shared/schemas';

// Local imports - settings view commands
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - settings view styles
import { settingsViewStyles } from './styles';

// Local imports - settings view tabs (side-effect: register)
import './tabs/MemoryTab';
import './tabs/HistoryTab';
import './tabs/ModelsTab';
import './tabs/AgentsTab';

const HISTORY_ACTION_COMMANDS: Record<string, string> = {
  delete: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
  restore: SETTINGS_VIEW_COMMANDS.RESTORE_AGENT,
  rerun: SETTINGS_VIEW_COMMANDS.RERUN_AGENT,
};

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
  @state() private remoteAgents: RemoteAgent[] = [];
  @state() private apiAccessMode: 'included' | 'personal' = 'personal';
  @state() private enabledProviders: string[] = [];
  @state() private allowedModels: string[] | null = [];
  @state() private accessExpiresAt: string | null = null;

  protected get readyCommand(): string | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Request all data on load
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_ENABLED);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_HISTORY_DATA);
    postMessage(SETTINGS_VIEW_COMMANDS.GET_PROFILE_DATA);
  }

  protected override handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('command' in raw)) {
      return;
    }

    const command = (raw as { command: string }).command;

    // Navigation messages
    if (command === SETTINGS_VIEW_COMMANDS.SET_TAB) {
      const msg = raw as { command: string; tabIndex: number };
      if (typeof msg.tabIndex === 'number') {
        this.selectedTabIndex = msg.tabIndex;
      }
      return;
    }

    // Memory messages
    if (command === SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY) {
      const result = UpdateMemoryMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[SettingsApp] Update memory message validation failed.',
          result.error,
        );
        return;
      }
      this.memoryItems = result.data.items ?? [];
      return;
    }

    if (command === SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED) {
      const result = UpdateMemoryEnabledMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[SettingsApp] Update memory enabled message validation failed.',
          result.error,
        );
        return;
      }
      this.memoryEnabled = result.data.enabled;
      this.memoryToggleDisabled = false;
      return;
    }

    // History messages
    if (command === SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY) {
      const result = UpdateHistoryMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[SettingsApp] Update history message validation failed.',
          result.error,
        );
        return;
      }
      this.historyItems = [...result.data.historyItems].sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      return;
    }

    if (command === SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED) {
      const result = HistoryClearedMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[SettingsApp] History cleared message validation failed.',
          result.error,
        );
        return;
      }
      this.historyItems = [];
      return;
    }

    // Profile messages
    if (command === SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE) {
      const result = UpdateProfileMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[SettingsApp] Update profile message validation failed.',
          result.error,
        );
        return;
      }

      const data = result.data;
      this.authenticated = data.authenticated;
      this.userEmail = data.user?.email ?? 'N/A';
      this.userId = data.user?.id ?? '';
      this.tier = data.tier ?? 'free';
      this.remoteAgents = data.remoteAgents ?? [];
      this.apiAccessMode = data.apiAccessMode;
      this.enabledProviders = data.enabledProviders ?? [];
      this.allowedModels = data.allowedModels ?? null;
      this.accessExpiresAt = data.accessExpiresAt ?? null;
      return;
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

  private handleMemoryToggleEnabled(
    event: CustomEvent<{ enabled: boolean }>,
  ): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_MEMORY_ENABLED, {
      enabled: event.detail.enabled,
    });
  }

  private handleMemoryOpenItem(
    event: CustomEvent<{ storagePath: string }>,
  ): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE, {
      storagePath: event.detail.storagePath,
    });
  }

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

  private handleSelectAgent(event: CustomEvent<{ agentName: string }>): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SELECT_AGENT, {
      agentName: event.detail.agentName,
    });
  }

  private handleApiAccessMode(
    event: CustomEvent<{ mode: 'included' | 'personal' }>,
  ): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE, {
      mode: event.detail.mode,
    });
  }

  private handleOpenVscodeSettings(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS);
  }

  private renderHeader(): TemplateResult {
    const settingsButton = html`
      <vscode-button
        appearance="secondary"
        title="Open VS Code Settings"
        @click=${this.handleOpenVscodeSettings}
      >
        <span class="codicon codicon-settings-gear"></span>
      </vscode-button>
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
            <vscode-button appearance="secondary" @click=${this.handleSignOut}>
              Sign Out
            </vscode-button>
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
          <vscode-button @click=${this.handleSignIn}>
            <span slot="start" class="codicon codicon-sign-in"></span>
            Sign In
          </vscode-button>
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
          <vscode-tab-header slot="header">Memory</vscode-tab-header>
          <vscode-tab-header slot="header">History</vscode-tab-header>
          <vscode-tab-header slot="header">Models</vscode-tab-header>
          <vscode-tab-header slot="header">Agents</vscode-tab-header>

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
              .enabledProviders=${this.enabledProviders}
              .allowedModels=${this.allowedModels}
              @profile-api-access-mode=${this.handleApiAccessMode}
            ></models-tab>
          </vscode-tab-panel>

          <vscode-tab-panel>
            <agents-tab
              .authenticated=${this.authenticated}
              .remoteAgents=${this.remoteAgents}
              @profile-select-agent=${this.handleSelectAgent}
            ></agents-tab>
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
