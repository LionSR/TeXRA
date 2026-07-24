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
import {
  API_KEY_PROVIDER_IDS,
  PROVIDER_DISPLAY_NAMES,
} from '@shared/constants/providers';

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
  agentSkillsEnabled,
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

  // Header auth actions (SettingsApp's own header buttons)
  private readonly handleSignIn = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_IN);
  };

  private readonly handleSignOut = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.SIGN_OUT);
  };

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

  private readonly handleOpenVscodeSettings = (): void => {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_VSCODE_SETTINGS);
  };

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
              .globalStreamingDefault=${globalStreamingDefault.get()}
              .modelSelectionItems=${modelSelectionItems.get()}
              .reliabilitySettings=${reliabilitySettings.get()}
              .helperModel=${helperModel.get()}
              .preferShortModelNames=${preferShortModelNames.get()}
              @provider-key-set=${this.handleSetProviderKey}
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
            ></agents-tab>
          </wa-tab-panel>

          <wa-tab-panel name="multi-agent">
            <multi-agent-tab
              .customPresets=${customPresets.get()}
              .orchestratorAgents=${orchestratorAgents.get()}
              .allowOrchestratorKill=${allowOrchestratorKill.get()}
              .detachSubagentsOnStop=${detachSubagentsOnStop.get()}
              .worktreeSupport=${gitWorktreeSupport.get()}
            ></multi-agent-tab>
          </wa-tab-panel>

          <wa-tab-panel name="tools">
            <tools-tab
              .items=${toolDashboardItems.get()}
              .loaded=${toolDashboardLoaded.get()}
              .bashApprovalEnabled=${bashApprovalEnabled.get()}
              .agentSkillsEnabled=${agentSkillsEnabled.get()}
              .showDesktopCrashReporting=${!isKnownUnsupported(
                unsupportedCommands.get(),
                SETTINGS_VIEW_COMMANDS.GET_DESKTOP_CRASH_REPORTING,
              )}
              .desktopCrashReportingEnabled=${desktopCrashReportingEnabled.get()}
              .desktopCrashReportingConfigured=${desktopCrashReportingConfigured.get()}
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
            ></ai-agents-tab>
          </wa-tab-panel>

          <wa-tab-panel name="git">
            <git-tab
              .markCommits=${gitMarkCommits.get()}
              .authorName=${gitAuthorName.get()}
              .authorEmail=${gitAuthorEmail.get()}
              .toggleDisabled=${!gitSettingsLoaded.get()}
              .unsupportedCommands=${unsupportedCommands.get()}
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
