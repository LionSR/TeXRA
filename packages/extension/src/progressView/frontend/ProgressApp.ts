import { create } from 'mutative';

// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

import { z } from 'zod';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

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
  createStreamState,
  STREAM_STATUS,
  type ProgressViewPlacement,
  type ProgressViewOutboundMessage,
  type StreamTabId,
  type StreamTabInfo,
  type TaskGroup,
} from '@shared/schemas';
import {
  SignalWatcher,
  signal,
  Signal,
  select,
  combine,
} from '@shared/signals';
import { codiconStyles, designTokens } from '@shared/styles';
import {
  registerTeXRAWebAwesomeIcons,
  TEXRA_ICON_LIBRARY,
} from '@shared/wa/webAwesomeIcons';
import { isProcessAgent } from '@shared/streams/agentKind';

// Local imports - progress view frontend
import { webviewStorage } from './webviewStorage';
import { setsEqual } from './utils';
import {
  createInitialState,
  EMPTY_STREAM_LOGS,
  getStreamState,
  isToolUseState,
  type StreamLogs,
  type StreamState,
} from './store';

/** Stable empty array for activeTaskGroups$ default (avoids new [] per read). */
const EMPTY_TASK_GROUPS: TaskGroup[] = [];

/** Stable empty map returned when no parent has active children. */
const EMPTY_CHILD_MAP: Map<StreamTabId, StreamTabInfo[]> = new Map();

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

// Local imports - progress view contexts
import {
  EMPTY_LOG_CONTEXT,
  EMPTY_PROCESS_OUTPUTS,
  EMPTY_STREAM_BY_ID,
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  processOutputContext,
  streamByIdContext,
  streamLogContext,
  streamStateContext,
  type ProcessOutputMap,
  type StreamByIdMap,
  type StreamContextValue,
  type StreamLogContextValue,
} from './contexts/streamContexts';
import type { FrontendEventHandlerContext } from './eventHandlers';
import type { VscTabsSelectEvent } from '@vscode-elements/elements/dist/vscode-tabs/vscode-tabs.js';

// Local imports - progress view components
import './components/StreamTabs';
import './components/ToolUseStreamContent';
import './components/WorkflowStreamContent';
import './components/ProcessStreamContent';
import './components/UserMessage';
import './components/StatisticsPanel';
import './components/LatexdiffResults';
import './components/ContextManagement';

// Local imports - progress view component types
import type { PermissionState } from './components/PermissionCard';

registerTeXRAWebAwesomeIcons();

// ---------------------------------------------------------------------------
// Collection equality helpers — avoid allocating temporary arrays in
// Signal.Computed evaluations that run on every state change.
// ---------------------------------------------------------------------------

// setsEqual is provided by the shared frontend utils module.

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
    codiconStyles,
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
        gap: var(--spacing-small);
        padding: var(--spacing-small) var(--spacing-small) var(--spacing-tiny);
        border-bottom: var(--border-thin) solid var(--color-border);
        flex-shrink: 0;
      }

      .view-header vscode-tabs {
        flex: 1;
        min-width: 0;
        --panel-display: none;
      }

      .view-header vscode-tab-header.focus-sidebar-tab {
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
        place-items: start center;
        padding: clamp(var(--spacing-large, 16px), 7vh, 72px)
          var(--spacing-large, 16px);
        overflow: auto;
        font-family:
          var(--texra-font-family, var(--vscode-font-family, system-ui)),
          sans-serif;
      }

      .progress-empty-panel {
        box-sizing: border-box;
        width: min(720px, 100%);
        padding: var(--spacing-xlarge, 24px);
        border: var(--border-thin, 1px) solid
          var(--color-border, var(--vscode-panel-border, #d0d7de));
        border-radius: var(--border-radius, 6px);
        background: var(--texra-editor-background, #fff);
      }

      .progress-empty-kicker {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small, 8px);
        margin-bottom: var(--spacing-medium, 12px);
        color: var(--color-text-secondary, #57606a);
        font-size: var(--font-size-sm, 13px);
        font-weight: var(--font-weight-semibold, 600);
      }

      .progress-empty-panel h2 {
        margin: 0 0 var(--spacing-small, 8px);
        color: var(--texra-foreground, #24292f);
        font-size: var(--font-size-xl, 22px);
        line-height: 1.25;
      }

      .progress-empty-panel p {
        margin: 0;
        color: var(--color-text-secondary, #57606a);
        line-height: var(--line-height-normal, 1.5);
      }

      .progress-empty-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-small, 8px);
        margin-top: var(--spacing-large, 16px);
      }

      .progress-empty-actions wa-button::part(base) {
        min-height: var(--height-button, 30px);
      }

      wa-icon {
        font-size: 1em;
      }

      vscode-split-layout {
        display: flex;
        width: 100%;
        height: 100%;
      }

      stream-tabs {
        min-width: 180px;
      }

      .main-container.narrow stream-tabs {
        min-width: 48px;
      }

      .content-area {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      /* Stream content containers - pass-through for layout */
      tool-use-stream-content,
      workflow-stream-content,
      process-stream-content {
        display: contents;
      }
    `,
  ];

  // --- Signal-based state ---
  // Single source of truth: monolithic state wrapped in a signal.
  // Mutative's structural sharing ensures unchanged branches keep their
  // reference, so selector computeds auto-skip via Object.is().
  private appState = signal(createInitialState());
  private placement = signal<ProgressViewPlacement>('sidebar');
  private narrowLayout = signal(false);
  private permissions$ = signal<PermissionState[]>([]);

  /** Stream IDs with pending approval requests — drives tab pulse indicator. */
  private _prevApprovalIds: Set<string> = new Set();
  private pendingApprovalIds$ = new Signal.Computed(() => {
    const ids = new Set<string>();
    for (const p of this.permissions$.get()) {
      const streamId = p.data.streamId;
      if (streamId) ids.add(streamId);
    }
    // Return stable reference when unchanged — Signal.Computed uses Object.is(),
    // so a new Set with identical contents would still propagate.
    if (setsEqual(ids, this._prevApprovalIds)) {
      return this._prevApprovalIds;
    }
    this._prevApprovalIds = ids;
    return ids;
  });

  private readonly resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? this.clientWidth;
    this.narrowLayout.set(width < 500);
  });

  @provide({ context: streamStateContext })
  @state()
  private streamContextValue: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @provide({ context: streamLogContext })
  @state()
  private streamLogContextValue: StreamLogContextValue = EMPTY_LOG_CONTEXT;

  @provide({ context: permissionsContext })
  @state()
  private permissionsContextValue: PermissionState[] = [];

  @provide({ context: processOutputContext })
  @state()
  private processOutputContextValue: ProcessOutputMap = EMPTY_PROCESS_OUTPUTS;

  @provide({ context: streamByIdContext })
  @state()
  private streamByIdContextValue: StreamByIdMap = EMPTY_STREAM_BY_ID;

  // --- Selector computeds: extract fields, auto-memoized by Object.is ---
  private streamById$ = select(this.appState, (s) => s.streamById);
  private streamFilter$ = select(this.appState, (s) => s.streamFilter);
  private streamStates$ = select(this.appState, (s) => s.streamStates);
  private streamLogs$ = select(this.appState, (s) => s.streamLogs);
  private activeStreamId$ = select(this.appState, (s) => s.activeStreamId);
  private processOutputs$ = select(this.appState, (s) => s.processOutputs);
  private followupOptions$ = select(
    this.appState,
    (s) => s.followupOptionsByStream,
  );

  // --- Derived computeds: only re-evaluate when selector inputs propagate ---

  private streams$ = new Signal.Computed(() => [
    ...this.streamById$.get().values(),
  ]);

  /** Top-level streams for the tab list (child streams excluded). */
  private tabStreams$ = combine(
    [this.streams$, this.streamFilter$] as const,
    (streams, filter) => {
      const topLevel = streams.filter((s) => !s.parentStreamId);
      if (filter === 'all') return topLevel;
      return topLevel.filter((s) => s.agentCategory === filter);
    },
  );

  /**
   * Child streams grouped by parent stream ID.
   * Depends only on streamById$ (stream registry), NOT streamStates$,
   * so it only recomputes when streams are added/removed — not on
   * every status or timestamp update.
   */
  private childStreamsByParent$ = new Signal.Computed(() => {
    const grouped = new Map<StreamTabId, StreamTabInfo[]>();
    for (const stream of this.streamById$.get().values()) {
      if (!stream.parentStreamId) continue;
      const siblings = grouped.get(stream.parentStreamId);
      if (siblings) {
        siblings.push(stream);
      } else {
        grouped.set(stream.parentStreamId, [stream]);
      }
    }
    return grouped.size > 0 ? grouped : EMPTY_CHILD_MAP;
  });

  // --- Fine-grained active-stream selectors ---
  // These return stable Map entry values (via Mutative structural sharing).
  // When stream B's state changes, activeStreamState$ still returns stream A's
  // state (same reference) → Object.is() passes → no downstream propagation.

  /** Only changes when active stream switches or stream list changes. */
  private activeStreamInfo$ = new Signal.Computed(() => {
    const id = this.activeStreamId$.get();
    return id ? (this.streamById$.get().get(id) ?? null) : null;
  });

  /**
   * True when the current filter yields at least one tab. Gates the
   * "no streams match" placeholder — backend now sends every stream
   * unfiltered, so `streamById.size` alone can't distinguish "nothing
   * visible" from "everything hidden by filter".
   */
  private hasStreams$ = new Signal.Computed(
    () => this.tabStreams$.get().length > 0,
  );

  private hasAnyStreams$ = new Signal.Computed(
    () => this.streams$.get().length > 0,
  );

  /** Only changes when the ACTIVE stream's state changes, not any stream. */
  private activeStreamState$ = new Signal.Computed(() => {
    const info = this.activeStreamInfo$.get();
    if (!info) return null;
    return (
      this.streamStates$.get().get(info.name) ??
      createStreamState(info.agentCategory)
    );
  });

  /** Only changes when the ACTIVE stream's logs change, not any stream. */
  private activeStreamLogs$ = new Signal.Computed(() => {
    const info = this.activeStreamInfo$.get();
    if (!info) return EMPTY_STREAM_LOGS;
    return this.streamLogs$.get().get(info.name) ?? EMPTY_STREAM_LOGS;
  });

  /** Only changes when the ACTIVE stream's process outputs change. */
  private activeProcessOutputs$ = new Signal.Computed((): ProcessOutputMap => {
    const info = this.activeStreamInfo$.get();
    if (!info) return EMPTY_PROCESS_OUTPUTS;
    return this.processOutputs$.get().get(info.name) ?? EMPTY_PROCESS_OUTPUTS;
  });

  // --- Leaf selectors for logContext$ ---
  // These extract the specific fields logContext$ needs from activeStreamState$,
  // so logContext$ doesn't depend on the full state. When conversationProgress,
  // badges, or status change, activeStreamState$ propagates but these return
  // the same refs (Mutative structural sharing) → logContext$ stays cached →
  // LogList doesn't re-render.

  private activeTaskGroups$ = new Signal.Computed(
    () => this.activeStreamState$.get()?.taskGroups ?? EMPTY_TASK_GROUPS,
  );

  private activeIsToolUse$ = new Signal.Computed(() => {
    const state = this.activeStreamState$.get();
    return state ? isToolUseState(state) : false;
  });

  /** Stream context derived from active stream + state. */
  private streamContext$ = new Signal.Computed((): StreamContextValue => {
    const activeStreamInfo = this.activeStreamInfo$.get();
    const hasStreams = this.hasStreams$.get();
    if (!activeStreamInfo) return { ...EMPTY_STREAM_CONTEXT, hasStreams };

    const streamState = this.activeStreamState$.get();
    const isToolUse = streamState ? isToolUseState(streamState) : false;
    const followupOptions =
      this.followupOptions$.get().get(activeStreamInfo.name) ?? null;
    return {
      streamInfo: activeStreamInfo,
      streamState,
      isToolUse,
      hasStreams,
      followupOptions,
    };
  });

  /**
   * Log context derived from active stream + logs.
   * Depends on leaf selectors so status/badge/progress changes
   * don't cause LogList re-renders.
   */
  private logContext$ = new Signal.Computed((): StreamLogContextValue => {
    const activeStreamInfo = this.activeStreamInfo$.get();
    const hasStreams = this.hasStreams$.get();
    if (!activeStreamInfo) return { ...EMPTY_LOG_CONTEXT, hasStreams };

    return {
      logs: this.activeStreamLogs$.get().logs,
      taskGroups: this.activeTaskGroups$.get(),
      isToolUse: this.activeIsToolUse$.get(),
      hasStreams,
      streamName: activeStreamInfo.name,
      // Process agents emit raw stdout/stderr; render them terminal-style
      // (monospace, no timestamps, tight spacing) rather than logger entries.
      terminalMode: isProcessAgent(activeStreamInfo.agent),
    };
  });

  private prefsManager = new PersistedState(
    webviewStorage,
    'progressViewPrefs',
    ProgressViewPrefsSchema,
  );

  constructor() {
    super();
    // Restore persisted preferences
    const prefs = this.prefsManager.getState();
    this.appState.set({
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

  /**
   * Sync signal-computed values into @provide/@state context properties.
   * SignalWatcher triggers requestUpdate() when any read signal changes,
   * so this runs only when computed values actually propagate.
   */
  protected override willUpdate(): void {
    this.streamContextValue = this.streamContext$.get();
    this.streamLogContextValue = this.logContext$.get();
    this.permissionsContextValue = this.permissions$.get();
    this.processOutputContextValue = this.activeProcessOutputs$.get();
    this.streamByIdContextValue = this.streamById$.get();
  }

  render(): TemplateResult {
    const isEditorMode = this.placement.get() === 'editor';
    const compactTabs = this.narrowLayout.get() && !isEditorMode;
    const hasAnyStreams = this.hasAnyStreams$.get();
    const splitPosition =
      this.getAttribute('data-desktop-view') === 'progress' ? '68%' : '80%';

    return html`
      <div
        class=${classMap({
          'main-container': true,
          narrow: compactTabs,
        })}
      >
        <div class="view-header">
          <vscode-tabs
            .selectedIndex=${1}
            @vsc-tabs-select=${this.onViewTabSelect}
          >
            <vscode-tab-header
              slot="header"
              class=${isEditorMode ? 'focus-sidebar-tab' : ''}
              title=${isEditorMode ? 'Focus Launcher sidebar' : ''}
              @click=${this.onFocusLauncherTab}
            >
              <span class="codicon codicon-edit"></span>
              Launcher
            </vscode-tab-header>
            <vscode-tab-header slot="header">
              <span class="codicon codicon-server-process"></span>
              Progress
            </vscode-tab-header>
          </vscode-tabs>

          <wa-button
            class="header-action"
            aria-label="Open dashboard"
            appearance="plain"
            size="s"
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
            size="s"
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
                <vscode-split-layout initial-handle-position=${splitPosition}>
                  <div
                    slot="start"
                    class="content-area"
                    @stream-switch=${this.onStreamSwitch}
                  >
                    ${this.renderStreamContent()}
                  </div>

                  <stream-tabs
                    slot="end"
                    .compact=${compactTabs}
                    .streams=${this.tabStreams$.get()}
                    .activeStreamId=${this.activeStreamId$.get()}
                    .filter=${this.streamFilter$.get()}
                    .streamStates=${this.streamStates$.get()}
                    .pendingApprovalStreamIds=${this.pendingApprovalIds$.get()}
                    .childStreamsByParent=${this.childStreamsByParent$.get()}
                    @stream-switch=${this.onStreamSwitch}
                    @stream-delete=${this.onStreamDelete}
                    @filter-change=${this.onFilterChange}
                    @delete-all=${this.onDeleteAll}
                  ></stream-tabs>
                </vscode-split-layout>
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
          <div class="progress-empty-kicker">
            <span class="codicon codicon-server-process"></span>
            Progress
          </div>
          <h2>No runs yet</h2>
          <p>
            Start an agent from the Launcher or Commands. New runs, streamed
            logs, approvals, and follow-up controls will appear here.
          </p>
          <div class="progress-empty-actions">
            <wa-button
              appearance="filled"
              variant="brand"
              size="m"
              type="button"
              @click=${this.onOpenLauncher}
            >
              <wa-icon
                slot="start"
                library=${TEXRA_ICON_LIBRARY}
                name="play"
                variant="solid"
              ></wa-icon>
              Open Launcher
            </wa-button>
            <wa-button
              appearance="outlined"
              variant="neutral"
              size="m"
              type="button"
              @click=${this.onOpenDashboard}
            >
              <wa-icon
                slot="start"
                library=${TEXRA_ICON_LIBRARY}
                name="gear"
                variant="solid"
              ></wa-icon>
              Open Dashboard
            </wa-button>
          </div>
        </div>
      </section>
    `;
  }

  /**
   * Render stream content based on stream type.
   * Single branch point - delegates to typed container components.
   */
  private renderStreamContent(): TemplateResult {
    const { streamInfo, streamState, isToolUse } = this.streamContextValue;
    if (!streamInfo || !streamState) {
      // No active stream - show empty log-list
      return html`<log-list></log-list>`;
    }

    // Process agents (e.g. bash) proxy raw stdout/stderr — render them with a
    // dedicated terminal-style container, not the LLM workflow/tool-use chrome.
    if (isProcessAgent(streamInfo.agent)) {
      return html`
        <process-stream-content
          @toolbar-command=${this.onToolbarCommand}
        ></process-stream-content>
      `;
    }

    // Single branch point: delegate to typed container component
    if (isToolUse) {
      return html`
        <tool-use-stream-content
          @toolbar-command=${this.onToolbarCommand}
          @permission-action=${this.onPermissionAction}
          @followup-change=${this.onFollowUpChange}
          @followup-send=${this.onFollowUpSend}
          @followup-polish=${this.onFollowUpPolish}
          @followup-clear=${this.onFollowUpClear}
          @followup-focus-complete=${this.onFollowUpFocusComplete}
        ></tool-use-stream-content>
      `;
    }

    // Workflow stream (default for non-tool-use)
    return html`
      <workflow-stream-content
        @toolbar-command=${this.onToolbarCommand}
        @permission-action=${this.onPermissionAction}
        @file-action=${this.onFileAction}
        @compile-fixer-run=${this.onCompileFixerRun}
        @followup-request-options=${this.onFollowupRequestOptions}
        @followup-setup=${this.onFollowupSetup}
        @followup-run=${this.onFollowupRun}
      ></workflow-stream-content>
    `;
  }

  protected handleMessage(message: ProgressViewOutboundMessage): void {
    dispatchMessage(message, this.createMessageHandlerContext());
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    const state = this.appState.get();
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
    this.appState.set(
      create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      }),
    );
  }

  private setStreamLogs(
    streamId: StreamTabId,
    updater: (prev: StreamLogs) => StreamLogs,
  ): void {
    const state = this.appState.get();
    // Skip unknown streams — prevents orphan streamLogs entries that survive
    // updateStreamInfo cleanup (which only iterates streamStates keys)
    if (!state.streamStates.has(streamId)) return;
    const current = state.streamLogs.get(streamId) ?? EMPTY_STREAM_LOGS;
    const updated = updater(current);
    if (updated === current) return;
    this.appState.set(
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
      getState: () => this.appState.get(),
      setState: (updater) => {
        this.appState.set(updater(this.appState.get()));
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
      getPermissions: () => this.permissions$.get(),
      setPermissions: (permissions) => {
        this.permissions$.set(permissions);
      },
      setPlacement: (placement) => {
        this.placement.set(placement);
      },
    };
  }

  private onViewTabSelect = (event: VscTabsSelectEvent): void => {
    const view = event.detail.selectedIndex === 0 ? 'main' : 'progress';
    if (view === 'main' && this.placement.get() === 'editor') {
      this.focusLauncherSidebar(
        event.currentTarget as { selectedIndex?: number },
      );
      return;
    }
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view });
  };

  private onFocusLauncherTab = (event: Event): void => {
    if (this.placement.get() !== 'editor') return;
    event.preventDefault();
    event.stopPropagation();
    const tabs = (event.currentTarget as HTMLElement).closest(
      'vscode-tabs',
    ) as { selectedIndex?: number } | null;
    this.focusLauncherSidebar(tabs ?? undefined);
  };

  private onOpenLauncher = (): void => {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'main' });
  };

  private focusLauncherSidebar(tabs?: { selectedIndex?: number }): void {
    postMessage(COMMON_COMMANDS.SWITCH_VIEW, { view: 'main' });
    if (!tabs) return;
    requestAnimationFrame(() => {
      tabs.selectedIndex = 1;
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
    const streamId = this.appState.get().activeStreamId;
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
