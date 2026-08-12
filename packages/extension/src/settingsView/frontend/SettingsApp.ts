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
  SETTINGS_TAB_PANEL_NAMES,
  type SettingsTabPanelName,
  type SettingsViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { assertSupported, isKnownUnsupported } from '@shared/utils/dispatcher';
import {
  registerTeXRAWebAwesomeIcons,
  waIcon,
} from '@shared/wa/webAwesomeIcons';

// Local imports - settings view
import {
  SETTINGS_NAV_GROUPS,
  type SettingsNavEntry,
  type SettingsNavGroup,
} from './settingsNav';
import { settingsViewStyles } from './styles';

// Side-effect: register tab components
import './tabs/MemoryTab';
import './tabs/AccountTab';
import './tabs/SubscriptionsTab';
import './tabs/GoalTab';
import './tabs/HistoryTab';
import './tabs/ModelsTab';
import './tabs/AgentsTab';
import './tabs/MultiAgentTab';
import './tabs/ToolsTab';
import './tabs/AIAgentsTab';
import './tabs/GitTab';
import './tabs/LaTeXTab';
import './tabs/ShortcutsTab';
import './components/profile/ProviderKeyModal';

// Local imports - module-scope settings state + composed message handlers
import { settingsViewHandlers } from './messageDispatcher';
import {
  agentSubTab,
  agentSkillsEnabled,
  allowOrchestratorKill,
  apiAccessMode,
  authenticated,
  approvalPolicy,
  bashApprovalEnabled,
  chatgptAuth,
  grokAuth,
  claudeAgentEffort,
  claudeAgentModel,
  claudeAgentPermissionMode,
  codexApprovalPolicy,
  codexReasoningEffort,
  codexSandboxMode,
  copilotRouteInfos,
  customAgentDir,
  customAgentDirIsDefault,
  customPresets,
  detachSubagentsOnStop,
  editApprovalEnabled,
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
  sessionProblem,
  spendingStatus,
  spendingStatusError,
  subscriptionUsage,
  tier,
  telemetryEnabled,
  toolDashboardItems,
  toolDashboardLoaded,
  toolPathProtectionEnabled,
  agentSelectionItems,
  unsupportedCommands,
  userEmail,
} from './settingsState';
import type { HistoryTab } from './tabs/HistoryTab';

registerTeXRAWebAwesomeIcons();

const MAX_TIMEOUT_MS = 2_147_483_647;

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

  private monthlyProfileRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    // State lives at module scope in `settingsState.ts` and is shared across
    // remounts in the same JS context (tests, hot reload), so every signal
    // starts fresh on construction.
    resetSettingsState();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.scheduleMonthlyProfileRefresh();
  }

  override disconnectedCallback(): void {
    if (this.monthlyProfileRefreshTimer !== undefined) {
      clearTimeout(this.monthlyProfileRefreshTimer);
      this.monthlyProfileRefreshTimer = undefined;
    }
    super.disconnectedCallback();
  }

  private scheduleMonthlyProfileRefresh(): void {
    if (this.monthlyProfileRefreshTimer !== undefined) {
      clearTimeout(this.monthlyProfileRefreshTimer);
    }
    const now = Date.now();
    const date = new Date(now);
    const nextMonthUtc = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      1,
    );
    const delay = Math.min(nextMonthUtc - now, MAX_TIMEOUT_MS);
    this.monthlyProfileRefreshTimer = setTimeout(() => {
      if (Date.now() >= nextMonthUtc) {
        const view = this.getAttribute('data-desktop-view');
        postMessage(
          SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
          view == null ? {} : { view },
        );
      }
      this.scheduleMonthlyProfileRefresh();
    }, delay);
  }

  // Outbound message handlers (extension host → settings webview), composed
  // from the domain slices under `./slices/` (see `messageDispatcher.ts`).
  // HISTORY_CLEARED is overridden here to additionally clear the
  // `<history-tab>` search box — a DOM ref this component owns via `@query`,
  // not signal state, so it can't live in the slice itself. `assertSupported`
  // narrows the `historySlice` entry out of the registry's
  // `Handler | Unsupported` union (see `@shared/utils/dispatcher`), which is
  // the narrowing the dispatcher would do were this not a direct call.
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

  private selectSettingsEntry(entry: SettingsNavEntry): void {
    const selectedIndex = SETTINGS_TAB_PANEL_NAMES.indexOf(entry.panel);
    if (selectedIndex < 0) return;
    selectedTabIndex.set(selectedIndex);
    requestAnimationFrame(() => {
      const panel =
        this.shadowRoot?.querySelector<HTMLElement>('.settings-panel');
      if (panel) panel.scrollTop = 0;
    });
  }

  // Provider-key entry flow. Lives here (not in a leaf component) because it
  // branches on `isDesktopHost` — a `BaseWebviewApp` capability — to choose
  // between the in-webview modal (desktop) and the host prompt (VS Code).
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

  private handleManageProviderKeys(): void {
    selectedTabIndex.set(SETTINGS_TAB.MODELS);
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

  private entriesForGroup(
    group: SettingsNavGroup,
    goalSupported: boolean,
  ): readonly SettingsNavEntry[] {
    return group.entries.filter(
      (entry) =>
        (entry.panel !== SETTINGS_TAB_PANEL_BY_NAME.GOAL || goalSupported) &&
        (entry.panel !== SETTINGS_TAB_PANEL_BY_NAME.SHORTCUTS ||
          this.isDesktopHost),
    );
  }

  private renderSettingsNavigation(
    activeGroup: SettingsNavGroup,
    activePanel: SettingsTabPanelName,
    goalSupported: boolean,
  ): TemplateResult {
    const activeEntries = this.entriesForGroup(activeGroup, goalSupported);

    return html`
      <nav class="settings-navigation" aria-label="Settings">
        <div class="settings-category-nav" aria-label="Settings categories">
          ${SETTINGS_NAV_GROUPS.map((group) => {
            const entries = this.entriesForGroup(group, goalSupported);
            if (entries.length === 0) return nothing;
            const active = group === activeGroup;
            return html`
              <wa-button
                class="settings-category-button"
                appearance="plain"
                size="s"
                aria-label=${group.label}
                aria-pressed=${String(active)}
                data-active=${String(active)}
                data-group=${group.label}
                @click=${() => this.selectSettingsEntry(entries[0])}
              >
                ${waIcon(group.icon, { slot: 'start' })} ${group.label}
              </wa-button>
            `;
          })}
        </div>
        <!-- Plain toggle-button strip, not tablist/tab: these buttons switch
             the whole page but implement none of the APG tabs keyboard
             contract (no arrow keys/roving tabindex), and role="tab" on a
             wa-button nests a native button role. aria-pressed matches the
             actual behavior — same pattern as the category nav above. -->
        <div
          class="settings-page-nav"
          aria-label=${`${activeGroup.label} pages`}
        >
          ${activeEntries.map((entry) => {
            const active = entry.panel === activePanel;
            return html`
              <wa-button
                class="settings-page-button"
                appearance="plain"
                size="s"
                aria-label=${`${activeGroup.label}: ${entry.label}`}
                aria-pressed=${String(active)}
                data-active=${String(active)}
                data-panel=${entry.panel}
                title=${entry.label}
                @click=${() => this.selectSettingsEntry(entry)}
              >
                ${waIcon(entry.icon, {
                  className: 'settings-tab-icon',
                  slot: 'start',
                })}
                <span class="settings-tab-label">${entry.label}</span>
              </wa-button>
            `;
          })}
        </div>
      </nav>
    `;
  }

  private renderActivePanel(
    activePanel: SettingsTabPanelName,
    desktopHost: boolean,
    goalSupported: boolean,
  ): TemplateResult {
    switch (activePanel) {
      case 'account':
        return html`
          <account-tab
            .authenticated=${authenticated.get()}
            .userEmail=${userEmail.get()}
            .tier=${tier.get()}
            .sessionProblem=${sessionProblem.get()}
            .spendingStatus=${spendingStatus.get()}
            .spendingStatusError=${spendingStatusError.get()}
            .quotaAutoSwitched=${quotaAutoSwitched.get()}
            .telemetryEnabled=${telemetryEnabled.get()}
            @manage-provider-keys=${this.handleManageProviderKeys}
          ></account-tab>
        `;
      case 'subscriptions':
        return html`
          <subscriptions-tab
            .chatgptAuth=${chatgptAuth.get()}
            .grokAuth=${grokAuth.get()}
            .usage=${subscriptionUsage.get()}
            .copilotModels=${copilotRouteInfos.get()}
          ></subscriptions-tab>
        `;
      case 'models':
        return html`
          <models-tab
            .authenticated=${authenticated.get()}
            .apiAccessMode=${apiAccessMode.get()}
            .spendingStatus=${spendingStatus.get()}
            .providerKeyStatuses=${providerKeyStatuses.get()}
            .globalStreamingDefault=${globalStreamingDefault.get()}
            .modelSelectionItems=${modelSelectionItems.get()}
            .helperModel=${helperModel.get()}
            .preferShortModelNames=${preferShortModelNames.get()}
            @provider-key-set=${this.handleSetProviderKey}
          ></models-tab>
        `;
      case 'agents':
        return html`
          <agents-tab
            .agents=${agentSelectionItems.get()}
            .customAgentDir=${customAgentDir.get()}
            .customAgentDirIsDefault=${customAgentDirIsDefault.get()}
            .initialSubTab=${agentSubTab.get()}
            .userTier=${tier.get()}
            .reliabilitySettings=${reliabilitySettings.get()}
            .unsupportedCommands=${unsupportedCommands.get()}
          ></agents-tab>
        `;
      case 'multi-agent':
        return html`
          <multi-agent-tab
            .customPresets=${customPresets.get()}
            .orchestratorAgents=${orchestratorAgents.get()}
            .allowOrchestratorKill=${allowOrchestratorKill.get()}
            .detachSubagentsOnStop=${detachSubagentsOnStop.get()}
            .worktreeSupport=${gitWorktreeSupport.get()}
          ></multi-agent-tab>
        `;
      case 'tools':
        return html`
          <tools-tab
            .items=${toolDashboardItems.get()}
            .loaded=${toolDashboardLoaded.get()}
            .approvalPolicy=${approvalPolicy.get()}
            .bashApprovalEnabled=${bashApprovalEnabled.get()}
            .editApprovalEnabled=${editApprovalEnabled.get()}
            .toolPathProtectionEnabled=${toolPathProtectionEnabled.get()}
            .agentSkillsEnabled=${agentSkillsEnabled.get()}
          ></tools-tab>
        `;
      case 'ai-agents':
        return html`
          <ai-agents-tab
            .items=${toolDashboardItems.get()}
            .loaded=${toolDashboardLoaded.get()}
            .codexSandboxMode=${codexSandboxMode.get()}
            .codexReasoningEffort=${codexReasoningEffort.get()}
            .codexApprovalPolicy=${codexApprovalPolicy.get()}
            .claudeAgentModel=${claudeAgentModel.get()}
            .claudeAgentPermissionMode=${claudeAgentPermissionMode.get()}
            .claudeAgentEffort=${claudeAgentEffort.get()}
          ></ai-agents-tab>
        `;
      case 'latex':
        return html`
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
          ></latex-tab>
        `;
      case 'git':
        return html`
          <git-tab
            .markCommits=${gitMarkCommits.get()}
            .authorName=${gitAuthorName.get()}
            .authorEmail=${gitAuthorEmail.get()}
            .toggleDisabled=${!gitSettingsLoaded.get()}
            .unsupportedCommands=${unsupportedCommands.get()}
            .githubTokenStatus=${githubTokenStatus.get()}
            .prSubscriptions=${prSubscriptions.get()}
          ></git-tab>
        `;
      case 'shortcuts':
        return html`<shortcuts-tab></shortcuts-tab>`;
      case 'history':
        return html`
          <history-tab
            .items=${historyItems.get()}
            .unsupportedCommands=${unsupportedCommands.get()}
          ></history-tab>
        `;
      case 'goal':
        return goalSupported
          ? html`<goal-tab .items=${goalItems.get()}></goal-tab>`
          : this.renderDesktopUnavailablePanel(
              'Goals unavailable',
              'This host does not support autonomous goals.',
            );
      case 'memory':
        return html`
          <memory-tab
            .items=${memoryItems.get()}
            .enabled=${memoryEnabled.get()}
            .toggleDisabled=${memoryToggleDisabled.get()}
          ></memory-tab>
        `;
    }
    // Exhaustiveness guard: `activePanel` is a `SettingsTabPanelName`, so every
    // entry in `SETTINGS_TAB_ORDER` must have a case above. A tab appended to
    // `SETTINGS_TAB_ORDER` with no case here is a compile error on the
    // assignment below instead of silently rendering the Memory panel (the
    // old `case 'memory': default:` fusion). The guard is unreachable at
    // runtime for any valid panel, so an unknown value is a loud throw, not a
    // quiet wrong panel.
    const unhandled: never = activePanel;
    throw new Error(`Unhandled settings panel: ${unhandled}`);
  }

  override render(): TemplateResult {
    const desktopHost = this.isDesktopHost;
    const goalSupported = !isKnownUnsupported(
      unsupportedCommands.get(),
      SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
    );
    const requestedPanel =
      SETTINGS_TAB_PANEL_NAMES[selectedTabIndex.get()] ??
      SETTINGS_TAB_PANEL_BY_NAME.ACCOUNT;
    const activePanel =
      !desktopHost && requestedPanel === SETTINGS_TAB_PANEL_BY_NAME.SHORTCUTS
        ? SETTINGS_TAB_PANEL_BY_NAME.ACCOUNT
        : requestedPanel;
    const activeGroup =
      SETTINGS_NAV_GROUPS.find((group) =>
        group.entries.some((entry) => entry.panel === activePanel),
      ) ?? SETTINGS_NAV_GROUPS[0];
    const activeEntry = activeGroup.entries.find(
      (entry) => entry.panel === activePanel,
    );

    return html`
      <div class="settings-container">
        ${this.renderSettingsNavigation(
          activeGroup,
          activePanel,
          goalSupported,
        )}
        <section
          class="settings-panel"
          aria-label=${activeEntry?.label ?? 'Settings'}
        >
          ${
            activeEntry
              ? html`
                  <header class="settings-page-header tab-content-container">
                    <div class="settings-page-header-copy">
                      <h1>${activeEntry.label}</h1>
                      <p>${activeEntry.description}</p>
                    </div>
                  </header>
                `
              : nothing
          }
          ${this.renderActivePanel(activePanel, desktopHost, goalSupported)}
        </section>
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
