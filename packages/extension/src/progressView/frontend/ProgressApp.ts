import { create } from 'mutative';

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import { z } from 'zod';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';

// Local imports - shared webview
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/hostBridge';
import { PersistedState } from '@shared/state';

// Local imports - shared schemas
import {
  AgentCategoryFilterSchema,
  type ProgressViewOutboundMessage,
} from '@shared/schemas';
import { SignalWatcher } from '@shared/signals';
import { designTokens, viewTabStyles } from '@shared/styles';
import { registerTeXRAWebAwesomeIcons } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderViewHeader } from '@shared/wa/viewHeader';
import '@shared/wa/tabs';
import type { MutableWaTabGroup, WaTabShowEvent } from '@shared/wa/tabs';

// Local imports - progress view frontend
import { progressAppStyles } from './progressAppStyles';
import { webviewStorage } from './webviewStorage';
import { isToolUseState } from './store';
import {
  activeStreamId$,
  appState,
  childStreamsByParent$,
  hasAnyStreams$,
  narrowLayout,
  pendingApprovalIds$,
  permissions$,
  placement,
  resetProgressState,
  setStreamLogsForId,
  setStreamStateForId,
  streamFilter$,
  streamStates$,
  tabStreams$,
} from './progressState';

// Local imports - event handlers
import {
  handleDeleteAll,
  handleFileAction,
  handleFilterChange,
  handleFollowupRequestOptions,
  handleFollowUpChange,
  handleFollowUpClear,
  handleFollowUpPolish,
  handleFollowUpSend,
  handleGettingStartedAction,
  handlePermissionAction,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  runCompileFixer,
  sendFollowupCommand,
} from './eventHandlers';
import { dispatchMessage } from './messageDispatcher';
import type { PermissionActionDetail } from './events';
import type {
  FrontendEventHandlerContext,
  MessageHandlerContext,
} from './messageHandlerTypes';
// Local imports - progress view components
import './components/StreamTabs';
import './components/StreamConversation';
import './components/UserMessage';
import './components/StatisticsPanel';
import './components/LatexdiffResults';
import './components/ContextManagement';

/** Schema for persisted preferences. */
const ProgressViewPrefsSchema = z.object({
  streamFilter: AgentCategoryFilterSchema.catch('all'),
});

registerTeXRAWebAwesomeIcons();

// Cast: BaseWebviewApp is abstract, but SignalWatcher expects a concrete constructor.
// Safe because ProgressApp implements all abstract members below.
const ProgressAppBase = SignalWatcher(
  BaseWebviewApp as unknown as new (
    ...args: any[]
  ) => BaseWebviewApp<ProgressViewOutboundMessage>,
);

@customElement('progress-app')
export class ProgressApp extends ProgressAppBase {
  // Static 'styles' override lost through mixin type erasure; still works at runtime.
  static styles = [designTokens, viewTabStyles, progressAppStyles];

  // --- Signal-based state ---
  // State lives at module scope in `progressState.ts` (PRD: docs/prds/2026-05-08-electron-shell-layout.md § 7.A)
  // so the rail and the conversation can mount independently in different DOM
  // trees. Identity is preserved — selectors here are simple imports.
  private hasHandledInitialProgressTabShow = false;
  private suppressNextResetProgressTabShow = false;

  private readonly resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? this.clientWidth;
    narrowLayout.set(width < 500);
  });

  private prefsManager = new PersistedState(
    webviewStorage,
    'progressViewPrefs',
    ProgressViewPrefsSchema,
  );

  constructor() {
    super();
    // Module-level state is shared across remounts in the same JS context
    // (tests, hot reload). Reset writable signals + the approval-id memo,
    // then layer the persisted streamFilter pref on top of the post-reset
    // appState — keeps the constructor to one `appState.set` instead of two.
    resetProgressState();
    const prefs = this.prefsManager.getState();
    appState.set({
      ...appState.get(),
      streamFilter: prefs.streamFilter,
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.resizeObserver.disconnect();
    super.disconnectedCallback();
  }

  protected get readyCommand(): string | null {
    return PROGRESS_VIEW_COMMANDS.WEBVIEW_READY;
  }

  render(): TemplateResult {
    const isEditorMode = placement.get() === 'editor';
    const isDesktopMode = this.hasAttribute('data-desktop-view');
    const compactTabs = narrowLayout.get() && !isEditorMode;
    const hasAnyStreams = hasAnyStreams$.get();
    const splitPosition =
      this.getAttribute('data-desktop-view') === 'progress' ? 68 : 80;

    return html`
      <div
        class=${classMap({
          'main-container': true,
          narrow: compactTabs,
          desktop: isDesktopMode,
        })}
      >
        ${renderViewHeader({
          active: 'progress',
          dashboardButtonId: 'progressOpenDashboardButton',
          launcherTab: {
            focusSidebar: isEditorMode,
            title: isEditorMode ? 'Focus Launcher sidebar' : undefined,
            onClick: this.onFocusLauncherTab,
          },
          onOpenDashboard: this.onOpenDashboard,
          onTabShow: this.onViewTabShow,
          secondaryAction: {
            id: 'progressPopOutButton',
            label: isEditorMode ? 'Back to sidebar' : 'Open in editor',
            icon: isEditorMode ? 'backward-step' : 'picture-in-picture',
            onClick: isEditorMode ? this.onPopBack : this.onPopOut,
          },
        })}
        ${
          hasAnyStreams
            ? html`
                <div class="split-container">
                  <wa-split-panel .position=${splitPosition}>
                    <stream-conversation
                      slot="start"
                      @stream-switch=${this.onStreamSwitch}
                      @toolbar-command=${this.onToolbarCommand}
                      @permission-action=${this.onPermissionAction}
                      @file-action=${handleFileAction}
                      @compile-fixer-run=${this.onCompileFixerRun}
                      @getting-started-action=${handleGettingStartedAction}
                      @followup-request-options=${this.onFollowupRequestOptions}
                      @followup-setup=${this.onFollowupSetup}
                      @followup-run=${this.onFollowupRun}
                      @followup-change=${this.onFollowUpChange}
                      @followup-send=${this.onFollowUpSend}
                      @followup-polish=${this.onFollowUpPolish}
                      @followup-clear=${this.onFollowUpClear}
                      @followup-focus-complete=${this.onFollowUpFocusComplete}
                    ></stream-conversation>

                    <stream-tabs
                      slot="end"
                      .heading=${compactTabs ? '' : 'Sessions'}
                      .compact=${compactTabs}
                      .streams=${tabStreams$.get()}
                      .activeStreamId=${activeStreamId$.get()}
                      .filter=${streamFilter$.get()}
                      .streamStates=${streamStates$.get()}
                      .pendingApprovalStreamIds=${pendingApprovalIds$.get()}
                      .childStreamsByParent=${childStreamsByParent$.get()}
                      @stream-switch=${this.onStreamSwitch}
                      @stream-delete=${this.onStreamDelete}
                      @filter-change=${this.onFilterChange}
                      @delete-all=${handleDeleteAll}
                    ></stream-tabs>
                  </wa-split-panel>
                </div>
              `
            : this.renderEmptyState()
        }
      </div>
    `;
  }

  private renderEmptyState(): TemplateResult {
    return html`
      <section class="progress-empty-state">
        <div class="progress-empty-panel">
          ${renderEmptyState({
            icon: 'robot',
            kicker: 'Progress',
            title: 'No runs yet',
            body: 'Start an agent from the Launcher or Commands. New runs, streamed logs, approvals, and follow-up controls will appear here.',
            actions: [
              {
                label: 'Open Launcher',
                icon: 'play',
                appearance: 'filled',
                variant: 'brand',
                onClick: this.onOpenLauncher,
              },
              {
                label: 'Open Dashboard',
                icon: 'gear',
                appearance: 'outlined',
                variant: 'neutral',
                onClick: this.onOpenDashboard,
              },
            ],
          })}
        </div>
      </section>
    `;
  }

  protected override handleMessage(raw: unknown): void {
    dispatchMessage(raw, this.createMessageHandlerContext(), (error) => {
      const command =
        raw && typeof raw === 'object' && 'command' in raw
          ? String((raw as { command: unknown }).command)
          : 'unknown';
      this.logSchemaError(
        `[ProgressApp] Message validation failed for command "${command}".`,
        error,
      );
    });
  }

  /**
   * Get the event handler context.
   * Always returns fresh context - closures capture current state via getters.
   * Stream mutators delegate to the module-level helpers in `progressState`
   * (shared with the desktop renderer).
   */
  private getEventHandlerContext(): FrontendEventHandlerContext {
    return {
      getState: () => appState.get(),
      setState: (updater) => {
        appState.set(updater(appState.get()));
      },
      setStreamState: setStreamStateForId,
      setStreamLogs: setStreamLogsForId,
      savePrefs: (prefs) => this.prefsManager.update(prefs),
    };
  }

  private createMessageHandlerContext(): MessageHandlerContext {
    return {
      ...this.getEventHandlerContext(),
      getPermissions: () => permissions$.get(),
      setPermissions: (permissions) => {
        permissions$.set(permissions);
      },
      setPlacement: (next) => {
        placement.set(next);
      },
    };
  }

  private onViewTabShow = (event: WaTabShowEvent): void => {
    if (event.detail.name === 'progress') {
      if (this.suppressNextResetProgressTabShow) {
        this.suppressNextResetProgressTabShow = false;
        this.hasHandledInitialProgressTabShow = true;
        return;
      }
      if (!this.hasHandledInitialProgressTabShow) {
        this.hasHandledInitialProgressTabShow = true;
        return;
      }
    }
    const view = event.detail.name === 'launcher' ? 'main' : 'progress';
    const tabs = event.currentTarget as MutableWaTabGroup;
    if (view === 'main' && placement.get() === 'editor') {
      this.focusLauncherSidebar(tabs);
      return;
    }
    if (view === 'main') {
      postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view });
      this.resetProgressTab(tabs);
      return;
    }
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view });
  };

  private onFocusLauncherTab = (event: Event): void => {
    if (placement.get() !== 'editor') return;
    event.preventDefault();
    event.stopPropagation();
    const tabs = (event.currentTarget as HTMLElement).closest(
      'wa-tab-group',
    ) as MutableWaTabGroup | null;
    this.focusLauncherSidebar(tabs ?? undefined);
  };

  private onOpenLauncher = (): void => {
    this.focusLauncherSidebar();
  };

  private focusLauncherSidebar(tabs?: MutableWaTabGroup): void {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'main' });
    if (!tabs) return;
    this.resetProgressTab(tabs);
  }

  private resetProgressTab(tabs: MutableWaTabGroup): void {
    requestAnimationFrame(() => {
      if (tabs.active === 'progress') return;
      this.suppressNextResetProgressTabShow = true;
      tabs.active = 'progress';
    });
  }

  private onOpenDashboard = (): void => {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'dashboard' });
  };

  private onPopOut = (): void => {
    postMessage(PROGRESS_VIEW_COMMANDS.POP_OUT);
  };

  private onPopBack = (): void => {
    postMessage(PROGRESS_VIEW_COMMANDS.POP_BACK);
  };

  // Event handler wrappers - delegate to extracted handlers
  private onStreamSwitch = (e: CustomEvent): void =>
    handleStreamSwitch(e, this.getEventHandlerContext());
  private onStreamDelete = (e: CustomEvent): void =>
    handleStreamDelete(e, this.getEventHandlerContext());
  private onPermissionAction = (e: CustomEvent<PermissionActionDetail>): void =>
    handlePermissionAction(e, this.createMessageHandlerContext());

  // Event handlers requiring context
  private onFilterChange = (e: CustomEvent): void =>
    handleFilterChange(e, this.getEventHandlerContext());

  private onToolbarCommand = (e: CustomEvent): void =>
    handleToolbarCommand(e, this.getEventHandlerContext());

  private onFollowUpChange = (e: CustomEvent): void =>
    handleFollowUpChange(e, this.getEventHandlerContext());

  private onFollowUpSend = (e: CustomEvent): void =>
    handleFollowUpSend(e, this.getEventHandlerContext());

  private onFollowUpPolish = (): void =>
    handleFollowUpPolish(this.getEventHandlerContext());

  private onFollowUpClear = (e: CustomEvent): void =>
    handleFollowUpClear(e, this.getEventHandlerContext());

  private onCompileFixerRun = (): void =>
    runCompileFixer(this.getEventHandlerContext());

  private onFollowupRequestOptions = (): void =>
    handleFollowupRequestOptions(this.getEventHandlerContext());

  private onFollowupSetup = (e: CustomEvent): void =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP,
      e,
      this.getEventHandlerContext(),
    );

  private onFollowupRun = (e: CustomEvent): void =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP,
      e,
      this.getEventHandlerContext(),
    );

  /**
   * Reset focus/polish/transcription triggers after they've been consumed.
   * Part of Lit-native Phase 9e reactive property pattern.
   */
  private onFollowUpFocusComplete(): void {
    const streamId = appState.get().activeStreamId;
    if (!streamId) return;

    setStreamStateForId(streamId, (prev) => {
      if (!isToolUseState(prev)) return prev;
      return create(prev, (draft) => {
        draft.ui.shouldFocusFollowUp = false;
        draft.ui.polishedText = null;
        draft.ui.transcribedText = null;
      });
    });
  }
}
