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
  type ModelChangeDetail,
  type MultipleFilesActionDetail,
  type MultipleFilesTypeActionDetail,
  type ReorderFilesDetail,
  type RemoveFileDetail,
  type SessionTypeChangeDetail,
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
  changeModel,
  changeSessionType,
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

  private readonly onLatexdiffGetCurrentFile =
    this.detailHandler<FileActionDetail>(({ type }) => getCurrentFile(type));

  private readonly onLatexdiffEmptyFile = this.detailHandler<FileActionDetail>(
    ({ type }) => emptyFile(type),
  );

  private readonly onAddOpenedFiles =
    this.detailHandler<MultipleFilesTypeActionDetail>(({ type }) => {
      if (type !== 'output') {
        addOpenedFiles(type as DocumentFileType);
      }
    });

  private readonly onEmptyFiles =
    this.detailHandler<MultipleFilesTypeActionDetail>(({ type }) =>
      emptyFiles(type),
    );

  private readonly onSelectMultipleFiles =
    this.detailHandler<MultipleFilesActionDetail>(({ listId }) =>
      selectMultipleFiles(listId),
    );

  private readonly onRemoveFile = this.detailHandler<RemoveFileDetail>(
    ({ listId, file }) => removeFile(listId, file),
  );

  private readonly onFilesReordered = this.detailHandler<ReorderFilesDetail>(
    ({ listId, files }) => updateMultiFiles(listId, files),
  );

  private readonly onCheckboxChange = this.detailHandler<CheckboxChangeDetail>(
    ({ id, checked }) => updateCheckboxValue(id, checked),
  );

  private readonly onFocusInstruction =
    this.detailCommandHandler<FocusInstructionDetail>(
      MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION,
      ({ key, text }) => ({ key, text }),
    );

  private readonly onApiKeyAction = this.detailHandler<BannerActionDetail>(
    ({ action }) => runApiKeyBannerAction(action as 'set' | 'guide'),
  );

  private readonly onAgentConfigAction = this.detailHandler<BannerActionDetail>(
    ({ action }) => runAgentConfigAction(action as 'edit' | 'dir' | 'docs'),
  );

  private readonly onDependencyDismiss = (): void => {
    dependencyBanner$.set({ visible: false });
  };

  private readonly onRecheckDependencies = this.commandHandler(
    MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES,
  );

  private readonly onOpenInstallGuide =
    this.detailCommandHandler<InstallGuideDetail>(
      MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE,
      ({ tool }) => ({ tool }),
    );

  private readonly onSignInFromBanner = this.commandHandler(
    MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER,
  );

  private readonly onWelcomeChatGpt = this.commandHandler(
    MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT,
  );

  private readonly onWelcomeApiKey = this.commandHandler(
    MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY,
  );

  private readonly onWelcomeSkip = this.commandHandler(
    MAIN_VIEW_COMMANDS.ONBOARDING_SKIP,
  );

  private readonly onOnboardingRunSetup = this.commandHandler(
    MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP,
  );

  private readonly onOnboardingOpenGettingStarted = this.commandHandler(
    MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED,
  );

  private readonly onOnboardingSkipSetup = this.commandHandler(
    MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP,
  );

  private readonly onDismissLogin = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER);
    loginBannerVisible$.set(false);
  };

  private readonly onDismissGettingStarted = (): void => {
    // Session-only dismissal; the host setting still gates whether FileManager
    // shows the empty-folder banner in the first place.
    gettingStartedDismissed$.set(true);
  };

  private readonly onGettingStartedAction =
    this.detailCommandHandler<GettingStartedActionDetail>(
      MAIN_VIEW_COMMANDS.GETTING_STARTED_ACTION,
      ({ action }) => ({ action }),
    );

  private readonly onDismissSessionHint = (): void => {
    postMessage(MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER);
    sessionHintDismissed$.set(true);
  };

  private readonly onLatexDiffsToggle =
    this.detailHandler<LatexDiffsToggleDetail>(({ visible }) => {
      latexdiffsVisible$.set(visible);
      saveState();
    });

  private readonly onLatexDiffsAction =
    this.detailHandler<LatexDiffsActionDetail>(({ action }) =>
      runLatexDiffsAction(action),
    );

  private readonly onBaseFileChange = this.detailHandler<BaseFileChangeDetail>(
    ({ value }) => setBaseFile(value),
  );

  private readonly onEditedFileChange =
    this.detailHandler<EditedFileChangeDetail>(({ value }) =>
      setEditedFile(value),
    );

  private readonly onCommitChange = this.detailHandler<CommitChangeDetail>(
    ({ value }) => setCommit(value),
  );

  private readonly onRefreshEditedFiles = (): void => {
    refreshEditedFiles();
  };

  private readonly onRefreshCommits = this.commandHandler(
    MAIN_VIEW_COMMANDS.REFRESH_COMMITS,
  );

  private readonly onSessionTypeChange =
    this.detailHandler<SessionTypeChangeDetail>(({ value }) =>
      changeSessionType(value),
    );

  private readonly onAgentChange = this.detailHandler<AgentChangeDetail>(
    ({ sessionType, value }) => changeAgent(sessionType, value),
  );

  private readonly onModelChange = this.detailHandler<ModelChangeDetail>(
    ({ value }) => changeModel(value),
  );

  private readonly onInstructionInput =
    this.detailHandler<InstructionChangeDetail>(({ value }) => {
      setInstruction(value);
      scheduleInstructionSave();
    });

  private readonly onInstructionPaste = (): void => {
    saveState();
  };

  private readonly onPanelAction = this.detailHandler<ActionDetail>(
    ({ action }) => runPanelAction(action),
  );

  private readonly onExecute = (): void => {
    executeAgent();
  };

  private readonly onAgentSettings = (): void => {
    runAgentConfigAction('edit');
  };

  private readonly onBrowseAllAgents = (): void => {
    runAgentConfigAction('edit');
  };

  private readonly onModelSettings = this.commandHandler(
    MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS,
  );

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

  private commandHandler(
    command: string,
    payload?: Record<string, unknown>,
  ): () => void {
    return () => postMessage(command, payload);
  }

  private detailHandler<TDetail>(
    handler: (detail: TDetail) => void,
  ): (event: CustomEvent<TDetail>) => void {
    return (event) => handler(event.detail);
  }

  private detailCommandHandler<TDetail>(
    command: string,
    getPayload: (detail: TDetail) => Record<string, unknown> | undefined,
  ): (event: CustomEvent<TDetail>) => void {
    return (event) => postMessage(command, getPayload(event.detail));
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
              @welcome-chatgpt=${this.onWelcomeChatGpt}
              @welcome-api-key=${this.onWelcomeApiKey}
              @welcome-skip=${this.onWelcomeSkip}
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
                  @onboarding-run-setup=${this.onOnboardingRunSetup}
                  @onboarding-open-getting-started=${
                    this.onOnboardingOpenGettingStarted
                  }
                  @onboarding-skip-setup=${this.onOnboardingSkipSetup}
                ></onboarding-setup-card>`
              : nothing
          }

          <instruction-panel
            .showSessionHint=${!sessionHintDismissed$.get()}
            @session-type-change=${this.onSessionTypeChange}
            @agent-change=${this.onAgentChange}
            @model-change=${this.onModelChange}
            @instruction-input=${this.onInstructionInput}
            @instruction-paste=${this.onInstructionPaste}
            @panel-action=${this.onPanelAction}
            @execute=${this.onExecute}
            @agent-settings=${this.onAgentSettings}
            @browse-all-agents=${this.onBrowseAllAgents}
            @model-settings=${this.onModelSettings}
            @focus-instruction=${this.onFocusInstruction}
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
            @api-key-action=${this.onApiKeyAction}
            @agent-config-action=${this.onAgentConfigAction}
            @dependency-dismiss=${this.onDependencyDismiss}
            @recheck-dependencies=${this.onRecheckDependencies}
            @open-install-guide=${this.onOpenInstallGuide}
            @sign-in=${this.onSignInFromBanner}
            @dismiss-login=${this.onDismissLogin}
            @dismiss-getting-started=${this.onDismissGettingStarted}
            @getting-started-action=${this.onGettingStartedAction}
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
                    @add-opened-files=${this.onAddOpenedFiles}
                    @empty-files=${this.onEmptyFiles}
                    @select-multiple-files=${this.onSelectMultipleFiles}
                    @remove-file=${this.onRemoveFile}
                    @files-reordered=${this.onFilesReordered}
                    @checkbox-change=${this.onCheckboxChange}
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
                  @latexdiffs-action=${this.onLatexDiffsAction}
                  @base-file-change=${this.onBaseFileChange}
                  @edited-file-change=${this.onEditedFileChange}
                  @get-current-file=${this.onLatexdiffGetCurrentFile}
                  @empty-file=${this.onLatexdiffEmptyFile}
                  @refresh-edited-files=${this.onRefreshEditedFiles}
                  @commit-change=${this.onCommitChange}
                  @refresh-commits=${this.onRefreshCommits}
                ></latexdiffs-section>
              `
        }
      </div>
    `;
  }
}
