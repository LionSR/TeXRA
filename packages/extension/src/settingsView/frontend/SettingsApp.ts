/** Main container for the unified settings view. */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { SignalWatcher } from '@shared/signals';
import { installToolbarTooltips } from '@shared/litControllers/TooltipController';

// Local imports - shared styles

// Local imports - shared schemas and constants
import {
  dispatchSettingsViewOutbound,
  type SettingsSectionName,
  type SettingsTabPanelName,
} from '@shared/settingsView/settingsViewMessages';
import { isUnrecognizedCommand } from '@shared/utils/dispatcher';
import { commonViewStyles, designTokens } from '@ui/styles';
import { nextTablistIndex } from '@ui/wa/tablistKeyboardNav';
import { registerTeXRAWebAwesomeIcons, waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - settings view
import { SETTINGS_NAV_ENTRIES, type SettingsNavEntry } from './settingsNav';
import { settingsViewStyles } from './styles';

// Side-effect: register tab components
import './tabs/MemoryTab';
import './tabs/AccountTab';
import './tabs/SubscriptionsTab';
import './tabs/ModelsTab';
import './tabs/AgentsTab';
import './tabs/MultiAgentTab';
import './tabs/ToolsTab';
import './tabs/SkillsTab';
import './tabs/GitTab';
import './tabs/LaTeXTab';
import './tabs/ShortcutsTab';

// Local imports - module-scope settings state + composed message handlers
import { settingsViewHandlers } from './messageDispatcher';
import {
  activePresetId,
  agentSubTab,
  agentSkillsEnabled,
  allowOrchestratorKill,
  authenticated,
  approvalPolicy,
  bashApprovalEnabled,
  chatgptCodexContextWindow,
  childRunConcurrencyBudget,
  compactionThresholdPercent,
  copilotRouteInfos,
  customAgentDir,
  customAgentDirIsDefault,
  customAgentScanIssues,
  customPresets,
  detachSubagentsOnStop,
  disabledSkills,
  disabledSkillSources,
  installedPlugins,
  multiAgentSettingsRevision,
  editApprovalEnabled,
  gitAuthorEmail,
  gitAuthorName,
  githubTokenStatus,
  gitMarkCommits,
  gitSettingsLoaded,
  gitWorktreeSupport,
  helperModel,
  inlineCriticismEnabled,
  latexdiffBetweenRounds,
  latexdiffChangesOnly,
  latexdiffMathMarkup,
  latexFormatter,
  latexSettingsLoaded,
  latexSettingsStatus,
  memoryEnabled,
  memoryItems,
  modelRetryMaxAttempts,
  modelSelectionItems,
  orchestratorAgents,
  preferShortModelNames,
  prSubscriptions,
  providerKeyStatuses,
  resetSettingsState,
  selectedPanel,
  selectedSections,
  settingSignal,
  sessionProblem,
  skillLoadIssues,
  skillsList,
  subscriptionAuth,
  subscriptionUsage,
  telemetryEnabled,
  toolDashboardItems,
  toolDashboardLoaded,
  toolPathProtectionEnabled,
  agentSelectionItems,
  workflowAutoCompile,
  workflowAutoOpenPdf,
  workflowRejectOnCompileFailure,
  userEmail,
} from './settingsState';

registerTeXRAWebAwesomeIcons();

@customElement('settings-app')
export class SettingsApp extends SignalWatcher(LitElement) {
  static override styles = [designTokens, commonViewStyles, settingsViewStyles];

  constructor() {
    super();
    // State lives at module scope in `settingsState.ts` and is shared across
    // remounts in the same JS context (tests, hot reload), so every signal
    // starts fresh on construction.
    resetSettingsState();
  }

  private readonly messageListener = (event: MessageEvent): void => {
    const raw: unknown = event.data;
    dispatchSettingsViewOutbound(raw, settingsViewHandlers, (error) => {
      // On the desktop this element shares the window with the whole shell,
      // so every desktop message reaches this listener too; one whose command
      // is not a settings-view command is another surface's, not a defect.
      if (this.isDesktopHost && isUnrecognizedCommand(error)) return;
      const command =
        raw && typeof raw === 'object' && 'command' in raw
          ? String((raw as { command: unknown }).command)
          : 'unknown';
      console.warn(
        `[SettingsApp] Message validation failed for command "${command}".`,
        error,
      );
    });
  };

  /** True when the Electron desktop renderer mounted this webview. */
  private get isDesktopHost(): boolean {
    return this.hasAttribute('data-desktop-view');
  }

  override connectedCallback(): void {
    super.connectedCallback();
    installToolbarTooltips();
    window.addEventListener('message', this.messageListener);
    this.postReady();
  }

  override disconnectedCallback(): void {
    window.removeEventListener('message', this.messageListener);
    super.disconnectedCallback();
  }

  /** Tell the host this view is mounted, tagged with the desktop surface. */
  private postReady(): void {
    const view = this.getAttribute('data-desktop-view');
    postMessage(
      SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
      view == null ? {} : { view },
    );
  }

  private selectSettingsEntry(
    entry: SettingsNavEntry,
    section?: SettingsSectionName,
  ): void {
    selectedPanel.set(entry.panel);
    if (section) {
      selectedSections.set({
        ...selectedSections.get(),
        [entry.panel]: section,
      });
    }
    requestAnimationFrame(() => {
      const panel =
        this.shadowRoot?.querySelector<HTMLElement>('.settings-panel');
      if (panel) panel.scrollTop = 0;
    });
  }

  /**
   * APG tabs keyboard contract for both nav rows: ArrowLeft/ArrowRight move
   * (wrapping), Home/End jump to the ends, and moving selects the tab.
   */
  private async handleTablistKeydown(event: KeyboardEvent): Promise<void> {
    const tablist = event.currentTarget as HTMLElement;
    const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
    const current = tabs.indexOf(event.target as HTMLElement);
    if (current < 0) return;
    const next = nextTablistIndex(event.key, current, tabs.length);
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].click();
    await this.updateComplete;
    tabs[next].focus();
  }

  private handleSetProviderKey(event: CustomEvent<{ provider: string }>): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY, {
      provider: event.detail.provider,
    });
  }

  /**
   * The pages and sections this host shows: Shortcuts edits desktop key
   * bindings only, and the recommended VS Code settings exist only in VS Code.
   */
  private navEntries(): readonly SettingsNavEntry[] {
    const desktop = this.isDesktopHost;
    return SETTINGS_NAV_ENTRIES.flatMap((entry) => {
      if (entry.panel === 'shortcuts' && !desktop) return [];
      if (!desktop) return [entry];
      return [
        {
          ...entry,
          sections: entry.sections.filter(
            ({ section }) => section !== 'vscode',
          ),
        },
      ];
    });
  }

  private renderSettingsNavigation(
    entries: readonly SettingsNavEntry[],
    activeEntry: SettingsNavEntry,
    activeSection: SettingsSectionName | undefined,
  ): TemplateResult {
    return html`
      <nav class="settings-navigation" aria-label="Settings">
        <div
          class="settings-page-nav"
          role="tablist"
          aria-label="Settings pages"
          @keydown=${this.handleTablistKeydown}
        >
          ${entries.map((entry) => {
            const active = entry === activeEntry;
            return html`
              <wa-button
                class="settings-page-button"
                appearance="plain"
                size="s"
                role="tab"
                aria-label=${entry.label}
                aria-selected=${String(active)}
                aria-controls="settings-panel"
                tabindex=${active ? '0' : '-1'}
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
        ${
          activeEntry.sections.length < 2
            ? nothing
            : html`
                <div
                  class="settings-page-nav settings-section-nav"
                  role="tablist"
                  aria-label=${`${activeEntry.label} sections`}
                  @keydown=${this.handleTablistKeydown}
                >
                  ${activeEntry.sections.map(({ section, label }) => {
                    const active = section === activeSection;
                    return html`
                      <wa-button
                        class="settings-page-button settings-section-button"
                        appearance="plain"
                        size="s"
                        role="tab"
                        aria-selected=${String(active)}
                        aria-controls="settings-panel"
                        tabindex=${active ? '0' : '-1'}
                        data-active=${String(active)}
                        data-section=${section}
                        @click=${() =>
                          this.selectSettingsEntry(activeEntry, section)}
                        >${label}</wa-button
                      >
                    `;
                  })}
                </div>
              `
        }
      </nav>
    `;
  }

  private renderActivePanel(
    activePanel: SettingsTabPanelName,
    section: SettingsSectionName | undefined,
    desktopHost: boolean,
  ): TemplateResult {
    switch (activePanel) {
      case 'models':
        return html`
          <models-tab
            .section=${section}
            .providerKeyStatuses=${providerKeyStatuses.get()}
            .modelSelectionItems=${modelSelectionItems.get()}
            .helperModel=${helperModel.get()}
            .preferShortModelNames=${preferShortModelNames.get()}
            .usage=${subscriptionUsage.get()}
            @provider-key-set=${this.handleSetProviderKey}
          >
            <subscriptions-tab
              slot="subscriptions"
              .ackGeneration=${multiAgentSettingsRevision.get()}
              .chatgptCodexContextWindow=${chatgptCodexContextWindow.get()}
              .subscriptionAuth=${subscriptionAuth.get()}
              .usage=${subscriptionUsage.get()}
              .copilotModels=${copilotRouteInfos.get()}
            ></subscriptions-tab>
          </models-tab>
        `;
      case 'agents': {
        // Touch the acknowledgement generation so a same-value rebroadcast
        // after a rejected/failed write still re-renders this branch and lets
        // live() restore the committed number-row value: the Advanced rows
        // ride the multi-agent snapshot.
        const ackGeneration = multiAgentSettingsRevision.get();
        return html`
          <agents-tab
            .section=${section}
            .ackGeneration=${ackGeneration}
            .agents=${agentSelectionItems.get()}
            .customAgentDir=${customAgentDir.get()}
            .customAgentDirIsDefault=${customAgentDirIsDefault.get()}
            .customAgentScanIssues=${customAgentScanIssues.get()}
            .initialSubTab=${agentSubTab.get()}
            .compactionThresholdPercent=${compactionThresholdPercent.get()}
            .modelRetryMaxAttempts=${modelRetryMaxAttempts.get()}
            .allowOrchestratorKill=${allowOrchestratorKill.get()}
            .detachSubagentsOnStop=${detachSubagentsOnStop.get()}
            .childRunConcurrencyBudget=${childRunConcurrencyBudget.get()}
            .worktreeSupport=${gitWorktreeSupport.get()}
          >
            <multi-agent-tab
              slot="teams"
              .activePresetId=${activePresetId.get()}
              .customPresets=${customPresets.get()}
              .orchestratorAgents=${orchestratorAgents.get()}
            ></multi-agent-tab>
            <skills-tab
              slot="skills"
              .masterEnabled=${agentSkillsEnabled.get()}
              .disabledSkills=${disabledSkills.get()}
              .disabledSources=${disabledSkillSources.get()}
              .plugins=${installedPlugins.get()}
              .skills=${skillsList.get()}
              .issues=${skillLoadIssues.get()}
            ></skills-tab>
          </agents-tab>
        `;
      }
      case 'tools': {
        const items = toolDashboardItems.get();
        // Read here, inside this watcher's render, so a snapshot that changes
        // one of the cards' inline settings re-renders the page.
        const settingValues = Object.fromEntries(
          items
            .flatMap((item) => item.settings ?? [])
            .map(([key]) => [key, settingSignal<string>(key).get()]),
        );
        return html`
          <tools-tab
            .section=${section}
            .items=${items}
            .loaded=${toolDashboardLoaded.get()}
            .approvalPolicy=${approvalPolicy.get()}
            .bashApprovalEnabled=${bashApprovalEnabled.get()}
            .editApprovalEnabled=${editApprovalEnabled.get()}
            .toolPathProtectionEnabled=${toolPathProtectionEnabled.get()}
            .settingValues=${settingValues}
          ></tools-tab>
        `;
      }
      case 'latex':
        return html`
          <latex-tab
            .section=${section}
            .settings=${latexSettingsStatus.get()}
            .loaded=${latexSettingsLoaded.get()}
            .desktopHost=${desktopHost}
            .autoCompile=${workflowAutoCompile.get()}
            .autoOpenPdf=${workflowAutoOpenPdf.get()}
            .rejectOnCompileFailure=${workflowRejectOnCompileFailure.get()}
            .diffBetweenRounds=${latexdiffBetweenRounds.get()}
            .diffChangesOnly=${latexdiffChangesOnly.get()}
            .diffMathMarkup=${latexdiffMathMarkup.get()}
            .formatter=${latexFormatter.get()}
            .inlineCriticismEnabled=${inlineCriticismEnabled.get()}
          ></latex-tab>
        `;
      case 'memory':
        return html`
          <memory-tab
            .items=${memoryItems.get()}
            .enabled=${memoryEnabled.get()}
          ></memory-tab>
        `;
      case 'general':
        return section === 'git'
          ? html`
              <git-tab
                .markCommits=${gitMarkCommits.get()}
                .authorName=${gitAuthorName.get()}
                .authorEmail=${gitAuthorEmail.get()}
                .toggleDisabled=${!gitSettingsLoaded.get()}
                .githubTokenStatus=${githubTokenStatus.get()}
                .prSubscriptions=${prSubscriptions.get()}
              ></git-tab>
            `
          : html`
              <account-tab
                .authenticated=${authenticated.get()}
                .userEmail=${userEmail.get()}
                .sessionProblem=${sessionProblem.get()}
                .telemetryEnabled=${telemetryEnabled.get()}
              ></account-tab>
            `;
      case 'shortcuts':
        return html`<shortcuts-tab></shortcuts-tab>`;
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
    const entries = this.navEntries();
    const activeEntry =
      entries.find((entry) => entry.panel === selectedPanel.get()) ??
      entries[0];
    const activePanel = activeEntry.panel;
    const remembered = selectedSections.get()[activePanel];
    const activeSection = (
      activeEntry.sections.find(({ section }) => section === remembered) ??
      activeEntry.sections[0]
    )?.section;

    return html`
      <div class="settings-container">
        ${this.renderSettingsNavigation(entries, activeEntry, activeSection)}
        <section
          id="settings-panel"
          class="settings-panel"
          role="tabpanel"
          aria-label=${activeEntry.label}
        >
          <header class="settings-page-header tab-content-container">
            <div class="settings-page-header-copy">
              <h1>${activeEntry.label}</h1>
              <p>${activeEntry.description}</p>
            </div>
          </header>
          ${this.renderActivePanel(activePanel, activeSection, desktopHost)}
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'settings-app': SettingsApp;
  }
}
