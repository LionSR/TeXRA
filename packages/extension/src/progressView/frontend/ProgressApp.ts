import { create } from 'mutative';

// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import { z } from 'zod';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';

// Local imports - shared webview
import {
  COMMON_COMMANDS,
  PROGRESS_VIEW_COMMANDS,
} from '@common/webview/commands';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/hostBridge';
import { PersistedState } from '@shared/state';

// Local imports - shared schemas
import {
  AgentCategoryFilterSchema,
  type ProgressViewOutboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import { SignalWatcher } from '@shared/signals';
import { designTokens, viewTabStyles } from '@shared/styles';
import {
  registerTeXRAWebAwesomeIcons,
  TEXRA_ICON_LIBRARY,
} from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import '@shared/wa/tabs';
import type { MutableWaTabGroup, WaTabShowEvent } from '@shared/wa/tabs';

// Local imports - progress view frontend
import { webviewStorage } from './webviewStorage';
import {
  createInitialState,
  EMPTY_STREAM_LOGS,
  getStreamState,
  isToolUseState,
  type StreamLogs,
  type StreamState,
} from './store';
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
  streamFilter$,
  streamStates$,
  tabStreams$,
} from './progressState';

/** Schema for persisted preferences. */
const ProgressViewPrefsSchema = z.object({
  streamFilter: AgentCategoryFilterSchema.catch('all'),
});

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
  handlePermissionAction,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  runCompileFixer,
  sendFollowupCommand,
} from './eventHandlers';
import {
  dispatchMessage,
  type MessageHandlerContext,
} from './messageDispatcher';

import type { FrontendEventHandlerContext } from './eventHandlers';
// Local imports - progress view components
import './components/StreamTabs';
import './components/StreamConversation';
import './components/UserMessage';
import './components/StatisticsPanel';
import './components/LatexdiffResults';
import './components/ContextManagement';

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
  static styles = [
    designTokens,
    viewTabStyles,
    css`
      :host {
        display: flex;
        flex: 1;
        min-height: 0;
        min-width: 0;
      }

      .main-container {
        display: flex;
        flex: 1;
        min-height: 0;
        min-width: 0;
        flex-direction: column;
        overflow: hidden;
      }

      .view-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-2xs) var(--wa-space-2xs) var(--wa-space-3xs);
        border-bottom: var(--border-thin) solid var(--color-border);
        flex-shrink: 0;
      }

      .main-container.desktop .view-header {
        display: none;
      }

      .view-header wa-tab.focus-sidebar-tab {
        opacity: var(--opacity-subtle);
        cursor: default;
      }

      .header-action {
        flex-shrink: 0;
      }

      .header-action::part(base) {
        min-height: var(--height-control, 24px);
      }

      .split-container {
        display: flex;
        flex: 1;
        min-height: 0;
      }

      .progress-empty-state {
        display: grid;
        flex: 1;
        min-height: 0;
        /* Center the empty-state card on both axes so the route does not
           show a tall stripe of unused space below the panel. The
           align-content: safe center keeps the card visible if the
           viewport is short enough that centering would clip it. */
        place-items: center;
        align-content: safe center;
        padding: var(--wa-space-l, 24px) var(--wa-space-s, 16px);
        overflow: auto;
        font-family:
          var(--wa-font-family-body, var(--wa-font-family-body, system-ui)),
          sans-serif;
      }

      .progress-empty-panel {
        box-sizing: border-box;
        width: min(720px, 100%);
        padding: var(--wa-space-l, 24px);
        border: var(--border-thin, 1px) solid
          var(--color-border, var(--wa-color-surface-border, #d0d7de));
        border-radius: var(--border-radius, 6px);
        background: var(--wa-color-surface-default, #fff);
      }

      .progress-empty-panel .empty-state-kicker {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs, 8px);
        margin-bottom: var(--wa-space-xs, 12px);
        color: var(--color-text-secondary, #57606a);
        font-size: var(--font-size-sm, 13px);
        font-weight: var(--font-weight-semibold, 600);
      }

      .progress-empty-panel .empty-state-title {
        margin: 0 0 var(--wa-space-2xs, 8px);
        color: var(--wa-color-text-normal, #24292f);
        font-size: var(--font-size-h2, 1.25em);
        font-weight: var(--font-weight-semibold, 600);
        line-height: var(--line-height-heading, 1.25);
      }

      .progress-empty-panel .empty-state-body {
        margin: 0;
        color: var(--color-text-secondary, #57606a);
        line-height: var(--line-height-normal, 1.5);
      }

      .progress-empty-panel .empty-state-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs, 8px);
        margin-top: var(--wa-space-s, 16px);
      }

      .progress-empty-panel .empty-state-actions wa-button::part(base) {
        min-height: var(--height-button, 30px);
      }

      wa-icon {
        font-size: 1em;
      }

      wa-split-panel {
        width: 100%;
        height: 100%;
      }

      stream-tabs {
        min-width: 180px;
      }

      .main-container.narrow stream-tabs {
        min-width: 48px;
      }

      .main-container.desktop stream-tabs {
        min-width: 240px;
        max-width: 360px;
      }

      /* .content-area and stream-content layout rules moved to
         components/StreamConversation.ts (the :host block + its shadow
         scope). The <stream-conversation> element is now the slot=start
         element directly. */

      .desktop-empty-progress {
        display: grid;
        place-items: center;
        flex: 1;
        min-height: 0;
        padding: clamp(32px, 8vh, 72px) 32px;
        box-sizing: border-box;
        background: var(--wa-color-surface-default, var(--background-color));
      }

      .desktop-empty-progress__body {
        display: grid;
        justify-items: center;
        gap: var(--wa-space-xs);
        max-width: 560px;
        text-align: center;
        color: var(--wa-color-text-quiet);
      }

      .desktop-empty-progress__icon {
        color: var(--wa-color-brand-fill-loud);
        font-size: 44px;
      }

      .desktop-empty-progress h1 {
        margin: var(--wa-space-2xs) 0 0;
        color: var(--wa-color-text-normal);
        font-size: 24px;
        font-weight: 600;
        letter-spacing: 0;
      }

      .desktop-empty-progress p {
        margin: 0;
        font-size: var(--font-size-md, 14px);
        line-height: 1.5;
      }

      .desktop-empty-progress__actions {
        display: flex;
        justify-content: center;
        flex-wrap: wrap;
        gap: var(--wa-space-xs);
        margin-top: var(--wa-space-2xs);
      }

      .desktop-empty-progress wa-button::part(base) {
        min-height: 32px;
      }
    `,
  ];

  // --- Signal-based state ---
  // State lives at module scope in `progressState.ts` (PRD: docs/prd/electron-shell-layout.md § 7.A)
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
    // Module-level state is shared across remounts. Reset everything to
    // initial values before re-applying persisted preferences so a remount
    // (tests, hot reload, future multi-instance hosts) doesn't surface
    // stale placement / approval pulses / narrow-layout state.
    resetProgressState();
    const prefs = this.prefsManager.getState();
    appState.set({
      ...createInitialState(),
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
        <div class="view-header">
          <wa-tab-group
            class="view-tabs"
            .active=${'progress'}
            without-scroll-controls
            @wa-tab-show=${this.onViewTabShow}
          >
            <wa-tab
              panel="launcher"
              class=${isEditorMode ? 'focus-sidebar-tab' : ''}
              title=${isEditorMode ? 'Focus Launcher sidebar' : ''}
              @click=${this.onFocusLauncherTab}
            >
              <wa-icon
                library=${TEXRA_ICON_LIBRARY}
                name="pencil"
                variant="solid"
              ></wa-icon>
              Launcher
            </wa-tab>
            <wa-tab panel="progress">
              <wa-icon
                library=${TEXRA_ICON_LIBRARY}
                name="robot"
                variant="solid"
              ></wa-icon>
              Progress
            </wa-tab>
            <wa-tab-panel name="launcher"></wa-tab-panel>
            <wa-tab-panel name="progress"></wa-tab-panel>
          </wa-tab-group>

          <wa-button
            class="header-action"
            aria-label="Open dashboard"
            appearance="plain"
            size="small"
            title="Open dashboard"
            @click=${this.onOpenDashboard}
          >
            <wa-icon
              library=${TEXRA_ICON_LIBRARY}
              name="gear"
              variant="solid"
            ></wa-icon>
          </wa-button>
          <wa-button
            class="header-action"
            aria-label=${isEditorMode ? 'Back to sidebar' : 'Open in editor'}
            appearance="plain"
            size="small"
            title=${isEditorMode ? 'Back to sidebar' : 'Open in editor'}
            @click=${isEditorMode ? this.onPopBack : this.onPopOut}
          >
            <wa-icon
              library=${TEXRA_ICON_LIBRARY}
              name=${isEditorMode ? 'backward-step' : 'picture-in-picture'}
              variant="solid"
            ></wa-icon>
          </wa-button>
        </div>

        ${hasAnyStreams
          ? html`
              <div class="split-container">
                <wa-split-panel .position=${splitPosition}>
                  <stream-conversation
                    slot="start"
                    @stream-switch=${this.onStreamSwitch}
                    @toolbar-command=${this.onToolbarCommand}
                    @permission-action=${this.onPermissionAction}
                    @file-action=${this.onFileAction}
                    @compile-fixer-run=${this.onCompileFixerRun}
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
                    @delete-all=${this.onDeleteAll}
                  ></stream-tabs>
                </wa-split-panel>
              </div>
            `
          : this.renderEmptyState()}
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

  protected handleMessage(message: ProgressViewOutboundMessage): void {
    dispatchMessage(message, this.createMessageHandlerContext());
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    const state = appState.get();
    // Fast path: stream already has state (common during streaming).
    // Only fall back to streamById lookup when creating default state for new streams.
    let current = state.streamStates.get(streamId);
    if (!current) {
      const streamInfo = state.streamById.get(streamId);
      // Skip unknown streams - they'll receive full state via LOG_DELTA after initialization
      if (!streamInfo) return;
      current = getStreamState(state, streamId, streamInfo.agentCategory);
    }
    const updated = updater(current);
    // Skip no-op updates: avoid Map copy + appState spread + willUpdate cycle
    if (updated === current) return;
    appState.set(
      create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      }),
    );
  }

  private setStreamLogs(
    streamId: StreamTabId,
    updater: (prev: StreamLogs) => StreamLogs,
  ): void {
    const state = appState.get();
    // Skip unknown streams — prevents orphan streamLogs entries that survive
    // updateStreamInfo cleanup (which only iterates streamStates keys)
    if (!state.streamStates.has(streamId)) return;
    const current = state.streamLogs.get(streamId) ?? EMPTY_STREAM_LOGS;
    const updated = updater(current);
    if (updated === current) return;
    appState.set(
      create(state, (draft) => {
        draft.streamLogs.set(streamId, updated);
      }),
    );
  }

  /**
   * Get the event handler context.
   * Always returns fresh context - closures capture current state via getters.
   */
  private getEventHandlerContext(): FrontendEventHandlerContext {
    return {
      getState: () => appState.get(),
      setState: (updater) => {
        appState.set(updater(appState.get()));
      },
      setStreamState: (streamId, updater) =>
        this.setStreamState(streamId, updater),
      setStreamLogs: (streamId, updater) =>
        this.setStreamLogs(streamId, updater),
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
  private onDeleteAll = (): void => handleDeleteAll();
  private onFileAction = (e: CustomEvent): void => handleFileAction(e);
  private onPermissionAction = (e: CustomEvent): void =>
    handlePermissionAction(e, this.createMessageHandlerContext());

  // Event handlers requiring context
  private onFilterChange = (e: CustomEvent): void =>
    handleFilterChange(e, this.getEventHandlerContext());

  private onToolbarCommand = (e: CustomEvent): void =>
    handleToolbarCommand(e, this.getEventHandlerContext());

  private onFollowUpChange = (e: CustomEvent): void =>
    handleFollowUpChange(e, this.getEventHandlerContext());

  private onFollowUpSend = (): void =>
    handleFollowUpSend(this.getEventHandlerContext());

  private onFollowUpPolish = (): void =>
    handleFollowUpPolish(this.getEventHandlerContext());

  private onFollowUpClear = (): void =>
    handleFollowUpClear(this.getEventHandlerContext());

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

    this.setStreamState(streamId, (prev) => {
      if (!isToolUseState(prev)) return prev;
      return create(prev, (draft) => {
        draft.ui.shouldFocusFollowUp = false;
        draft.ui.polishedText = null;
        draft.ui.transcribedText = null;
      });
    });
  }
}
