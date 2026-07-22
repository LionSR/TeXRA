import { html, nothing, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { SignalWatcher } from '@shared/signals';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/hostBridge';
import { designTokens, commonViewStyles, viewTabStyles } from '@shared/styles';
import {
  dispatchMainView,
  type ActionDetail,
  type AgentChangeDetail,
  type BannerActionDetail,
  type BaseFileChangeDetail,
  type CheckboxChangeDetail,
  type CommitChangeDetail,
  type EditedFileChangeDetail,
  type FileActionDetail,
  type FocusInstructionDetail,
  type GettingStartedActionDetail,
  type InstallGuideDetail,
  type InstructionChangeDetail,
  type LatexDiffsActionDetail,
  type LatexDiffsToggleDetail,
  type LaunchTargetChangeDetail,
  type ModelChangeDetail,
  type MultipleFilesActionDetail,
  type MultipleFilesTypeActionDetail,
  type ReorderFilesDetail,
  type RemoveFileDetail,
  type SessionTypeChangeDetail,
  type TeamChangeDetail,
} from '@shared/schemas';
import {
  registerTeXRAWebAwesomeIcons,
  waIcon,
} from '@shared/wa/webAwesomeIcons';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';
import { renderViewHeader } from '@shared/wa/viewHeader';
import type { MutableWaTabGroup, WaTabShowEvent } from '@shared/wa/tabs';
import '@shared/wa/tabs';

import './components/FileSelectGroup';
import './components/BannerGroup';
import './components/LatexDiffsSection';
import './components/InstructionPanel';
import './components/OnboardingWelcomeCard';
import './components/OnboardingSetupCard';
import { SESSION_TYPES, type DocumentFileType } from './constants';
import {
  agentConfigBanner$,
  apiKeyBanner$,
  commit$,
  debugMode$,
  dependencyBanner$,
  fileOptions$,
  fileSelectionOpen$,
  fileStateContext,
  fileStateContext$,
  gettingStartedDismissed$,
  gettingStartedVisible$,
  isGitRepo$,
  latexdiffsVisible$,
  loginBannerVisible$,
  onboardingFunnelState$,
  resetMainViewState,
  sessionContext,
  sessionContext$,
  sessionHintDismissed$,
  sessionType$,
  singleFiles$,
  type FileStateContextValue,
  type SessionContextValue,
} from './mainViewState';
import {
  addOpenedFiles,
  changeAgent,
  changeLaunchTarget,
  changeModel,
  changeSessionType,
  changeTeam,
  emptyFile,
  emptyFiles,
  executeAgent,
  getCurrentFile,
  refreshEditedFiles,
  refreshInstructionPlaceholder,
  removeFile,
  runAgentConfigAction,
  runApiKeyBannerAction,
  runLatexDiffsAction,
  runPanelAction,
  selectMultipleFiles,
  setBaseFile,
  setCommit,
  setEditedFile,
  setInstruction,
  updateCheckboxValue,
  updateMultiFiles,
} from './mainViewActions';
import {
  flushPendingInstructionSave,
  handleRestoreState,
  resetPersistenceRuntime,
  restorePersistedState,
  saveState,
  scheduleInstructionSave,
} from './persistence';
import { mainViewMessageHandlers } from './messageDispatcher';
import { FILE_SELECT_CONFIGS } from './store';
import { mainViewStyles } from './styles';

registerTeXRAWebAwesomeIcons();

// Cast: BaseWebviewApp is abstract, but SignalWatcher expects a concrete constructor.
// Safe because MainApp implements all abstract members below.
const MainAppBase = SignalWatcher(
  BaseWebviewApp as unknown as new (...args: any[]) => BaseWebviewApp,
);

@customElement('main-app')
export class MainApp extends MainAppBase {
  static styles = [
    designTokens,
    commonViewStyles,
    viewTabStyles,
    mainViewStyles,
  ];

  @state() protected override debugMode = false;

  @provide({ context: fileStateContext })
  @state()
  private fileStateContextValue: FileStateContextValue;

  @provide({ context: sessionContext })
  @state()
  private sessionContextValue: SessionContextValue;

  constructor() {
    super();
    // Per-mount slate: state and persistence runtime live at module scope
    // (see mainViewState.ts), so a remount in the same JS context (tests,
    // hot reload) must reset them like fresh instance fields used to.
    resetMainViewState();
    resetPersistenceRuntime();
    this.fileStateContextValue = fileStateContext$.get();
    this.sessionContextValue = sessionContext$.get();
  }

  // Named handlers only where an inline arrow won't do: multi-statement
  // bodies, plus the two handlers bound at two template sites each. Everything
  // else binds inline at its template site.

  private readonly onSignInFromBanner = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER);
  };

  private readonly onOnboardingOpenGettingStarted = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED);
  };

  private readonly onDismissLogin = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER);
    loginBannerVisible$.set(false);
  };

  private readonly onDismissGettingStarted = (): void => {
    // Session-only dismissal; the host setting still gates whether FileManager
    // shows the empty-folder banner in the first place.
    gettingStartedDismissed$.set(true);
  };

  private readonly onDismissSessionHint = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER);
    sessionHintDismissed$.set(true);
  };

  /** Team settings + the team picker's "Manage teams…" tail both open the
   * multi-agent settings section. */
  private readonly onOpenMultiAgentSettings = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS);
  };

  private readonly onLatexDiffsToggle = ({
    detail,
  }: CustomEvent<LatexDiffsToggleDetail>): void => {
    latexdiffsVisible$.set(detail.visible);
    saveState();
  };

  private readonly onInstructionInput = ({
    detail,
  }: CustomEvent<InstructionChangeDetail>): void => {
    setInstruction(detail.value);
    scheduleInstructionSave();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    restorePersistedState();
  }

  override disconnectedCallback(): void {
    flushPendingInstructionSave();
    super.disconnectedCallback();
  }

  protected handleMessage(raw: unknown): void {
    dispatchMainView(raw, mainViewMessageHandlers, (error) => {
      this.logSchemaError(
        '[MainApp] Main view message validation failed.',
        error,
      );
    });
  }

  protected override firstUpdated(): void {
    this.requestInitialData();
    refreshInstructionPlaceholder();
  }

  /**
   * Sync signal-computed values into @provide/@state context properties.
   * SignalWatcher triggers requestUpdate() when any read signal changes,
   * so this runs only when computed values actually propagate.
   */
  protected override willUpdate(): void {
    // Mirror the host-pushed @state flag into the module-scope signal that
    // feeds sessionContext$ (the signal graph can't observe plain fields).
    debugMode$.set(this.debugMode);
    this.fileStateContextValue = fileStateContext$.get();
    this.sessionContextValue = sessionContext$.get();
  }

  private requestInitialData(): void {
    const commands = [
      MAIN_VIEW_COMMANDS.GET_THEME,
      MAIN_VIEW_COMMANDS.GET_DEBUG_MODE,
      // Multi-list refresh: backend pushes back the current input/context/media
      // pickable file lists for the base-file dropdown and the multi-file picker.
      MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES,
      MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    ];
    commands.forEach((command) => postMessage(command));
  }

  protected override onStateRestore(message: StateRestoreMessage): void {
    const restored = handleRestoreState(message, (context, error) =>
      this.logSchemaError(context, error),
    );
    if (restored && message.executeImmediately) {
      executeAgent();
    }
  }

  private onViewTabShow = (event: WaTabShowEvent): void => {
    if (event.detail.name !== 'progress') return;
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'progress' });
    const tabs = event.currentTarget as MutableWaTabGroup;
    requestAnimationFrame(() => {
      tabs.active = 'launcher';
    });
  };

  private onOpenDashboard = (): void => {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'dashboard' });
  };

  private onPopOutProgress = (): void => {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, {
      view: 'progress',
      openInEditor: true,
    });
  };

  /** Launcher/Progress tabs plus header actions (hidden on the desktop host). */
  private renderViewHeader(): TemplateResult | typeof nothing {
    if (this.isDesktopHost) return nothing;
    return renderViewHeader({
      active: 'launcher',
      dashboardButtonId: 'openDashboardButton',
      onOpenDashboard: this.onOpenDashboard,
      onTabShow: this.onViewTabShow,
      secondaryAction: {
        id: 'popOutProgressButton',
        label: 'Open progress sessions in editor',
        icon: 'picture-in-picture',
        onClick: this.onPopOutProgress,
      },
    });
  }

  render(): TemplateResult {
    const onboardingState = onboardingFunnelState$.get();
    if (onboardingState === 'pending') {
      return html`
        <div class="content-wrapper">
          ${this.renderViewHeader()}
          <div class="main-content"></div>
        </div>
      `;
    }

    if (onboardingState === 'needs-credential') {
      // State 0 (PRD: agent-native onboarding): without a credential the
      // agent/model pickers, Files, and LaTeX Diffs are meaningless, and the
      // welcome card replaces the login/API-key/getting-started banners.
      return html`
        <div class="content-wrapper">
          ${this.renderViewHeader()}
          <div class="main-content">
            <onboarding-welcome-card
              @welcome-sign-in=${this.onSignInFromBanner}
              @welcome-chatgpt=${() =>
                postMessage(MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT)}
              @welcome-api-key=${() =>
                postMessage(MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY)}
              @welcome-skip=${() =>
                postMessage(MAIN_VIEW_COMMANDS.ONBOARDING_SKIP)}
              @onboarding-open-getting-started=${
                this.onOnboardingOpenGettingStarted
              }
            ></onboarding-welcome-card>
          </div>
        </div>
      `;
    }

    const isToolUse = sessionType$.get() === SESSION_TYPES.TOOL_USE;
    // Tool-use (interactive) agents read input/context via their own tools, so
    // only the Media group (pasted/added images the agent can view) is relevant
    // to them; workflow agents get the full set. Surfacing Media here lets an
    // interactive user see/confirm/remove a pasted figure instead of it being
    // attached invisibly.
    const visibleFileConfigs = isToolUse
      ? FILE_SELECT_CONFIGS.filter((config) => config.type === 'media')
      : FILE_SELECT_CONFIGS;

    const akb = apiKeyBanner$.get();
    const acb = agentConfigBanner$.get();
    const db = dependencyBanner$.get();
    const sf = singleFiles$.get();
    const fo = fileOptions$.get();

    return html`
      <div class="content-wrapper">
        ${this.renderViewHeader()}

        <div class="main-content">
          ${
            onboardingState === 'setup'
              ? html`<onboarding-setup-card
                  @onboarding-run-setup=${() =>
                    postMessage(MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP)}
                  @onboarding-open-getting-started=${
                    this.onOnboardingOpenGettingStarted
                  }
                  @onboarding-skip-setup=${() =>
                    postMessage(MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP)}
                ></onboarding-setup-card>`
              : nothing
          }

          <instruction-panel
            .showSessionHint=${!sessionHintDismissed$.get()}
            @session-type-change=${({
              detail,
            }: CustomEvent<SessionTypeChangeDetail>) =>
              changeSessionType(detail.value)}
            @launch-target-change=${({
              detail,
            }: CustomEvent<LaunchTargetChangeDetail>) =>
              changeLaunchTarget(detail.value)}
            @team-change=${({ detail }: CustomEvent<TeamChangeDetail>) =>
              changeTeam(detail.value)}
            @agent-change=${({ detail }: CustomEvent<AgentChangeDetail>) =>
              changeAgent(detail.sessionType, detail.value)}
            @model-change=${({ detail }: CustomEvent<ModelChangeDetail>) =>
              changeModel(detail.value)}
            @instruction-input=${this.onInstructionInput}
            @instruction-paste=${() => saveState()}
            @panel-action=${({ detail }: CustomEvent<ActionDetail>) =>
              runPanelAction(detail.action)}
            @execute=${() => executeAgent()}
            @agent-settings=${() => runAgentConfigAction('edit')}
            @browse-all-agents=${() => runAgentConfigAction('edit')}
            @team-settings=${this.onOpenMultiAgentSettings}
            @manage-teams=${this.onOpenMultiAgentSettings}
            @model-settings=${() =>
              postMessage(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS)}
            @focus-instruction=${({
              detail,
            }: CustomEvent<FocusInstructionDetail>) =>
              postMessage(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION, {
                key: detail.key,
                text: detail.text,
              })}
            @dismiss-session-hint=${this.onDismissSessionHint}
          ></instruction-panel>

          <banner-group
            .apiKeyBanner=${akb}
            .agentConfigBanner=${acb}
            .dependencyBanner=${db}
            .gettingStartedVisible=${
              gettingStartedVisible$.get() && !gettingStartedDismissed$.get()
            }
            .loginBannerVisible=${loginBannerVisible$.get()}
            @api-key-action=${({ detail }: CustomEvent<BannerActionDetail>) =>
              runApiKeyBannerAction(detail.action as 'set' | 'guide')}
            @agent-config-action=${({
              detail,
            }: CustomEvent<BannerActionDetail>) =>
              runAgentConfigAction(detail.action as 'edit' | 'dir' | 'docs')}
            @dependency-dismiss=${() =>
              dependencyBanner$.set({ visible: false })}
            @recheck-dependencies=${() =>
              postMessage(MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES)}
            @open-install-guide=${({
              detail,
            }: CustomEvent<InstallGuideDetail>) =>
              postMessage(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE, {
                tool: detail.tool,
              })}
            @sign-in=${this.onSignInFromBanner}
            @dismiss-login=${this.onDismissLogin}
            @dismiss-getting-started=${this.onDismissGettingStarted}
            @getting-started-action=${({
              detail,
            }: CustomEvent<GettingStartedActionDetail>) =>
              postMessage(MAIN_VIEW_COMMANDS.GETTING_STARTED_ACTION, {
                action: detail.action,
              })}
          ></banner-group>

          <wa-divider></wa-divider>
          <wa-details
            class="file-selection-details"
            ?open=${fileSelectionOpen$.get()}
            @wa-show=${(event: Event) => {
              // Filter by event source: child wa-dropdown components
              // inside the panel also emit wa-show/wa-hide which bubble
              // up. Without this guard, opening any dropdown inside
              // the Files panel re-flips fileSelectionOpen on the next
              // dropdown close (see webawesome#1540).
              if (event.target === event.currentTarget) {
                fileSelectionOpen$.set(true);
              }
            }}
            @wa-hide=${(event: Event) => {
              if (event.target === event.currentTarget) {
                fileSelectionOpen$.set(false);
              }
            }}
          >
            <span slot="summary" class="file-selection-summary">
              ${waIcon('folder-tree')} Files
            </span>
            <div class="file-selection-group">
              ${repeat(
                visibleFileConfigs,
                (config) => config.type,
                (config) => html`
                  <file-select-group
                    .config=${config}
                    @add-opened-files=${({
                      detail,
                    }: CustomEvent<MultipleFilesTypeActionDetail>) => {
                      if (detail.type !== 'output') {
                        addOpenedFiles(detail.type as DocumentFileType);
                      }
                    }}
                    @empty-files=${({
                      detail,
                    }: CustomEvent<MultipleFilesTypeActionDetail>) =>
                      emptyFiles(detail.type)}
                    @select-multiple-files=${({
                      detail,
                    }: CustomEvent<MultipleFilesActionDetail>) =>
                      selectMultipleFiles(detail.listId)}
                    @remove-file=${({
                      detail,
                    }: CustomEvent<RemoveFileDetail>) =>
                      removeFile(detail.listId, detail.file)}
                    @files-reordered=${({
                      detail,
                    }: CustomEvent<ReorderFilesDetail>) =>
                      updateMultiFiles(detail.listId, detail.files)}
                    @checkbox-change=${({
                      detail,
                    }: CustomEvent<CheckboxChangeDetail>) =>
                      updateCheckboxValue(detail.id, detail.checked)}
                  ></file-select-group>
                `,
              )}
            </div>
          </wa-details>
        </div>

        ${
          this.isDesktopHost
            ? nothing
            : html`
                <latexdiffs-section
                  .visible=${latexdiffsVisible$.get()}
                  .baseFile=${sf.baseFile}
                  .baseFileOptions=${fo.baseFile ?? []}
                  .editedFile=${sf.editedFile}
                  .editedFileOptions=${fo.editedFile ?? []}
                  .commit=${commit$.get()}
                  .commitOptions=${fo.commit ?? []}
                  .isGitRepo=${isGitRepo$.get()}
                  @latexdiffs-toggle=${this.onLatexDiffsToggle}
                  @latexdiffs-action=${({
                    detail,
                  }: CustomEvent<LatexDiffsActionDetail>) =>
                    runLatexDiffsAction(detail.action)}
                  @base-file-change=${({
                    detail,
                  }: CustomEvent<BaseFileChangeDetail>) =>
                    setBaseFile(detail.value)}
                  @edited-file-change=${({
                    detail,
                  }: CustomEvent<EditedFileChangeDetail>) =>
                    setEditedFile(detail.value)}
                  @get-current-file=${({
                    detail,
                  }: CustomEvent<FileActionDetail>) =>
                    getCurrentFile(detail.type)}
                  @empty-file=${({ detail }: CustomEvent<FileActionDetail>) =>
                    emptyFile(detail.type)}
                  @refresh-edited-files=${() => refreshEditedFiles()}
                  @commit-change=${({
                    detail,
                  }: CustomEvent<CommitChangeDetail>) =>
                    setCommit(detail.value)}
                  @refresh-commits=${() =>
                    postMessage(MAIN_VIEW_COMMANDS.REFRESH_COMMITS)}
                ></latexdiffs-section>
              `
        }
      </div>
    `;
  }
}
