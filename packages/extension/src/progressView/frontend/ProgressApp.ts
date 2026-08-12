// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';

// Local imports - shared webview
import { COMMON_COMMANDS, PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/hostBridge';

// Local imports - shared schemas
import type {
  ProgressViewOutboundMessage,
  StreamLifecycleStatus,
  StreamTabId,
} from '@shared/schemas';
import { Signal, SignalWatcher } from '@shared/signals';
import { designTokens, viewTabStyles } from '@shared/styles';
import { registerTeXRAWebAwesomeIcons } from '@shared/wa/webAwesomeIcons';
import { renderEmptyState } from '@shared/wa/emptyState';
import { renderViewHeader } from '@shared/wa/viewHeader';
import '@shared/wa/tabs';
import type { MutableWaTabGroup, WaTabShowEvent } from '@shared/wa/tabs';

// Local imports - progress view frontend
import { progressAppStyles } from './progressAppStyles';
import {
  activeStreamId$,
  childStreamsByParent$,
  diffStatusAnnouncement,
  hasAnyStreams$,
  narrowLayout,
  pendingApprovalIds$,
  permissions$,
  placement,
  resetProgressState,
  streamById$,
  streamStates$,
  topLevelStreams$,
} from './progressState';

// Local imports - event handlers
import {
  handleFileAction,
  handleFollowupRequestOptions,
  handleFollowUpChange,
  handleFollowUpFocusComplete,
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
// Local imports - progress view components
import './components/StreamTabs';
import './components/StreamConversation';

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

  // --- Status announcements (shell role="status" region) ---
  // The diff is event detection, not a pure projection, so it runs in an
  // explicit watcher effect with the memos here on the instance — never
  // inside a Signal.Computed, whose lazy, consumer-count-dependent
  // evaluation would make "what was already announced" ill-defined.
  @state() private statusAnnouncement = '';
  private announcedPermissionKeys: ReadonlySet<string> = new Set();
  private announcedStreamStatuses: ReadonlyMap<
    StreamTabId,
    StreamLifecycleStatus
  > = new Map();

  /**
   * Watcher callback runs during signal invalidation, where reading a signal
   * is not allowed — so the diff runs on a microtask, which also coalesces a
   * burst of `.set()` calls from one handler into one announcement pass.
   * Same pattern as webview/frontend/persistence.ts.
   */
  private readonly announcementWatcher = new Signal.subtle.Watcher(() => {
    queueMicrotask(() => {
      this.announcementWatcher.watch();
      this.updateStatusAnnouncement();
    });
  });

  private readonly resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? this.clientWidth;
    narrowLayout.set(width < 500);
  });

  constructor() {
    super();
    resetProgressState();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver.observe(this);
    this.announcementWatcher.watch(permissions$, streamStates$, streamById$);
    // Baseline pass: announce anything already pending at mount (the old
    // computed did so on first read) and seed the status memos so
    // already-finished runs never announce.
    this.updateStatusAnnouncement();
  }

  override disconnectedCallback(): void {
    this.announcementWatcher.unwatch(permissions$, streamStates$, streamById$);
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
            title: isEditorMode ? 'Focus New sidebar' : undefined,
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
                      @stream-switch=${handleStreamSwitch}
                      @toolbar-command=${handleToolbarCommand}
                      @permission-action=${handlePermissionAction}
                      @file-action=${handleFileAction}
                      @compile-fixer-run=${runCompileFixer}
                      @getting-started-action=${handleGettingStartedAction}
                      @followup-request-options=${handleFollowupRequestOptions}
                      @followup-setup=${this.onFollowupSetup}
                      @followup-run=${this.onFollowupRun}
                      @followup-change=${handleFollowUpChange}
                      @followup-send=${handleFollowUpSend}
                      @followup-polish=${handleFollowUpPolish}
                      @followup-focus-complete=${handleFollowUpFocusComplete}
                    ></stream-conversation>

                    <stream-tabs
                      slot="end"
                      .compact=${compactTabs}
                      .streams=${topLevelStreams$.get()}
                      .activeStreamId=${activeStreamId$.get()}
                      .streamStates=${streamStates$.get()}
                      .pendingApprovalStreamIds=${pendingApprovalIds$.get()}
                      .childStreamsByParent=${childStreamsByParent$.get()}
                      @stream-switch=${handleStreamSwitch}
                      @stream-delete=${handleStreamDelete}
                    ></stream-tabs>
                  </wa-split-panel>
                </div>
              `
            : this.renderEmptyState()
        }
        ${
          /*
          One stable, visually-hidden polite region for the whole shell:
          new approval requests and terminal run outcomes land here (see
          updateStatusAnnouncement). Stability matters — a region that is
          always mounted re-announces reliably on every text change, unlike
          a dynamically inserted alert. */
          html`<div class="visually-hidden" role="status">
            ${this.statusAnnouncement}
          </div>`
        }
      </div>
    `;
  }

  private updateStatusAnnouncement(): void {
    const next = diffStatusAnnouncement(
      this.announcedPermissionKeys,
      this.announcedStreamStatuses,
      permissions$.get(),
      streamStates$.get(),
      streamById$.get(),
    );
    this.announcedPermissionKeys = next.permissionKeys;
    this.announcedStreamStatuses = next.streamStatuses;
    if (next.text !== this.statusAnnouncement) {
      this.statusAnnouncement = next.text;
    }
  }

  private renderEmptyState(): TemplateResult {
    return html`
      <section class="progress-empty-state">
        <div class="progress-empty-panel">
          ${renderEmptyState({
            icon: 'robot',
            kicker: 'Sessions',
            title: 'No runs yet',
            body: 'Start an agent from the New tab or Commands. Runs, streamed logs, approvals, and follow-up controls will appear here.',
            actions: [
              {
                label: 'Open the New tab',
                icon: 'play',
                appearance: 'filled',
                variant: 'brand',
                onClick: this.onOpenLauncher,
              },
              {
                label: 'Open dashboard',
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
    dispatchMessage(raw, (error) => {
      this.logMessageSchemaError('[ProgressApp]', raw, error);
    });
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

  // `sendFollowupCommand` is shared by both followup entry points; these
  // arrows bind which backend command each event maps to.
  private onFollowupSetup = (e: CustomEvent): void =>
    sendFollowupCommand(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP, e);

  private onFollowupRun = (e: CustomEvent): void =>
    sendFollowupCommand(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP, e);
}
