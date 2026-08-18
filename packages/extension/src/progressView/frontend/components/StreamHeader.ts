// Third-party imports
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type {
  ConversationProgress,
  GoalStatus,
  StreamStage,
  StreamState,
  StreamSubstate,
  StreamTabInfo,
} from '@shared/schemas';
import {
  DEFAULT_STREAM_METADATA_STATUS,
  deriveGoalState,
  isPlainAgentIdentity,
  isToolUseState,
  isWorkflowState,
  STREAM_PHASE,
  STREAM_SUBSTATE,
} from '@shared/schemas';
import { UnsupportedCommandsMixin } from '@shared/wa/unsupportedCommandsMixin';
import { formatWorkflowRunContext } from '@shared/copy/workflowRunContext';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import {
  progressHeaderStatus,
  streamStatusIndicatorClass,
  type StreamStatusDisplayKey,
} from '@shared/streams/streamStatusDisplay';
import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { renderIconActionButtonParts } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';

// Local imports - progress view constants
import {
  ELEMENT_IDS,
  NEUTRAL_TOOLBAR,
  TOOLBAR_BUTTONS,
  type ProgressToolbarButton,
} from '../constants';
import {
  archivedContext,
  streamByIdContext,
  EMPTY_STREAM_BY_ID,
  type StreamByIdMap,
} from '../streamContexts';
import { ProgressEvents } from '../events';
import { streamDisplayLabel } from '../utils';
import { toolbarToggleStyles } from '../styles/toolbarToggleStyles';
import {
  renderProgressBadgeContent,
  getProgressBadgeTitle,
} from '../formatters/progressBadgeFormatter';

/**
 * Buttons enabled while a run is active (running / waiting / resuming): stop
 * plus the live-session controls (bypass toggles, compact, restore, storage,
 * export) and the run-context copy, whose text is worth handing off mid-run.
 */
const ACTIVE_STATE_BUTTONS = [
  ELEMENT_IDS.STOP_STREAM_BTN,
  ELEMENT_IDS.YOLO_TOGGLE_BTN,
  ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
  ELEMENT_IDS.COMPACT_RESPONSE_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
];

/**
 * Buttons enabled in every terminal (finished) state — failed / completed /
 * cancelled: the run is over, so re-run, resume, archive, diff, restore,
 * export, and the run-context copy are all available.
 */
const TERMINAL_STATE_BUTTONS = [
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.PACK_STREAM_BTN,
  ELEMENT_IDS.CLEAN_STREAM_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.DIFF_STREAM_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
];

/**
 * Terminal-set buttons that make no sense before the stream's first run:
 * there is no prior run to resume, and no outputs to copy context from.
 */
const NOT_YET_RUN_BUTTONS = new Set<string>([
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
]);

/**
 * Buttons enabled per phase/substate - pre-computed as Sets to avoid
 * allocating a new Set on every getButtonState() call during render.
 */
const ENABLED_BUTTONS_BY_DISPLAY_KEY: Record<
  StreamStatusDisplayKey,
  Set<string>
> = {
  [STREAM_SUBSTATE.STARTING]: new Set([
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.CLEAN_STREAM_BTN,
  ]),
  [STREAM_PHASE.RUNNING]: new Set(ACTIVE_STATE_BUTTONS),
  [STREAM_PHASE.FAILED]: new Set(TERMINAL_STATE_BUTTONS),
  [STREAM_PHASE.COMPLETED]: new Set(TERMINAL_STATE_BUTTONS),
  [STREAM_PHASE.CANCELLED]: new Set(TERMINAL_STATE_BUTTONS),
  ready: new Set(
    TERMINAL_STATE_BUTTONS.filter((id) => !NOT_YET_RUN_BUTTONS.has(id)),
  ),
  [STREAM_PHASE.WAITING]: new Set(ACTIVE_STATE_BUTTONS),
  [STREAM_SUBSTATE.RESUMING]: new Set(ACTIVE_STATE_BUTTONS),
};

/** Buttons that depend on having an executionId */
const EXECUTION_DEPENDENT_BUTTONS = new Set([
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.RESUME_BTN,
]);

/**
 * Native-agent-only controls. Resume, re-run, and restore relaunch the run's
 * stored config — which is borrowed for a workflow-script stream, synthetic
 * for a process stream, and owned by the external tool for a CLI-driven
 * session — so they are hidden (same mechanism as unsupported commands)
 * unless `identity` is a native agent run. An absent identity is still
 * pending and hides them too. Mirrors the backend gate in
 * `ProgressViewHost` / the `RESTORE_STATE` handler.
 */
const NATIVE_AGENT_ONLY_BUTTONS = new Set([
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
]);

@customElement('stream-header')
export class StreamHeader extends UnsupportedCommandsMixin(LitElement) {
  static override styles = [
    designTokens,
    commonViewStyles,
    statusIndicatorStyles,
    toolbarToggleStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
        min-width: 0;
        max-width: 100%;
        container-type: inline-size;
      }

      .log-header {
        padding: var(--wa-space-2xs)
          max(
            var(--wa-space-m),
            calc((100% - var(--conversation-header-width, 1040px)) / 2)
          );
        font-size: var(--font-size-sm);
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        min-height: var(--height-header);
        box-sizing: border-box;
        min-width: 0;
        max-width: 100%;
        color: var(--color-text-secondary);
        border-bottom: var(--border-thin) solid var(--color-border);
        background: color-mix(
          in srgb,
          var(--wa-color-surface-default) 94%,
          transparent
        );
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        flex: 1;
        min-width: 0;
        max-width: 100%;
      }

      #activeStreamName {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--wa-color-text-normal);
        font-size: var(--font-size);
        font-weight: var(--font-weight-semibold);
        letter-spacing: -0.012em;
      }

      .header-actions {
        display: flex;
        justify-content: flex-end;
        flex: 0 0 auto;
        min-width: 0;
        max-width: 100%;
        margin-inline-start: auto;
      }

      .header-actions wa-button-group {
        max-width: 100%;
        padding: 2px;
        border: var(--border-thin) solid var(--wa-color-surface-border);
        border-radius: var(--wa-border-radius-pill, 999px);
        background: var(--wa-color-neutral-fill-quiet);
      }

      /* Geometry comes from the shared icon-button skin via size="m"; the
         circular radius is the one local departure, so the toolbar reads as a
         segmented pill rather than a row of squares. */
      .header-actions .action-icon-button::part(base) {
        border-radius: var(--wa-border-radius-circle, 50%);
      }

      /* Status indicator overrides - base styles from statusIndicatorStyles.
         The hover label is a native <wa-tooltip> anchored to this dot via
         its "for" attribute. */
      .status-indicator {
        width: 7px;
        height: 7px;
        margin: 0 var(--wa-space-3xs);
      }

      /* Note: .is-ready and other status states from statusIndicatorStyles */

      .toolbar-button--hidden {
        display: none;
      }

      /* Button type styles */
      .stop-button {
        margin-inline-end: var(--wa-space-3xs);
        color: var(--color-error);
      }

      .pack-button {
        margin-inline-start: var(--wa-space-3xs);
      }

      .run-button {
        margin-inline-start: var(--wa-space-3xs);
        color: var(--color-success);
      }

      /* Native wa-badge (brand=active / warning=paused, quiet 'filled'
         appearance), compacted to the prior chip padding. */
      .goal-chip {
        flex-shrink: 0;
      }

      .goal-chip::part(base) {
        gap: var(--wa-space-3xs);
        padding: 0 var(--wa-space-2xs);
        font-weight: var(--font-weight-medium);
      }

      .goal-chip wa-icon {
        font-size: var(--font-size-xs);
      }

      .parent-link {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        padding: var(--wa-space-3xs) var(--wa-space-xs);
        background: var(--wa-color-neutral-fill-quiet);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        white-space: nowrap;
        border-radius: var(--border-radius-small);
        /* Secondary to the active title (#activeStreamName, flex:1) — cap it
           so a long parent label truncates instead of pushing the toolbar
           off-screen or wrapping the header. */
        flex-shrink: 1;
        min-width: 0;
        max-width: 40%;
      }

      .parent-link-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }

      .parent-link:hover {
        color: var(--color-text-link);
      }

      /* Radius only — the ring comes from focusRingStyles. */
      .parent-link:focus-visible {
        border-radius: var(--border-radius-small);
      }

      .parent-link wa-icon {
        font-size: var(--font-size-xs);
      }

      wa-tag.progress-badge wa-icon {
        font-size: var(--font-size-xs);
      }

      @container (max-width: 520px) {
        .log-header {
          padding-inline: var(--wa-space-xs);
          flex-wrap: wrap;
        }

        .header-left {
          flex-basis: 100%;
        }

        .header-actions {
          width: 100%;
          margin-inline-start: 0;
          justify-content: flex-start;
        }
      }
    `,
  ];

  @property({ attribute: false }) stream: StreamTabInfo | null = null;
  /**
   * The full stream state. The header derives its status/substate/progress/
   * stage display and the tool-use-only bypass/goal indicators from this one
   * object, so containers bind a single `.state` property instead of the
   * nine-prop sync surface the old `renderStreamHeader` wrapper maintained.
   */
  @property({ attribute: false }) state: StreamState | null = null;

  /** Read-only trace-viewer export: no toolbar action reaches a live backend. */
  @consume({ context: archivedContext, subscribe: true })
  private archived = false;

  /** Parent tab labels come from the parent's own tab info, not id parsing. */
  @consume({ context: streamByIdContext, subscribe: true })
  private streamById: StreamByIdMap = EMPTY_STREAM_BY_ID;

  /** Owns the copied/reset feedback for the run-context copy button. */
  private readonly copyRunContext = new CopyButtonController(this, {
    successTitle: 'Copied!',
  });

  /**
   * The run-context text for this stream, or `''` when there is nothing worth
   * copying (not a workflow stream, or no outputs and no compile failures) —
   * which is what disables the button.
   */
  private runContextText(
    stream: StreamTabInfo,
    state: StreamState | null | undefined,
  ): string {
    if (!state || !isWorkflowState(state)) return '';
    return formatWorkflowRunContext({
      stream,
      files: state.files,
      compileFailures: state.compileFailures,
    });
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.stream) {
      return nothing;
    }

    const state = this.state;
    const status = state?.status ?? DEFAULT_STREAM_METADATA_STATUS;
    const substate = state?.substate;
    const { label: statusLabel, displayKey } = progressHeaderStatus(
      status,
      substate,
    );
    const statusClass = streamStatusIndicatorClass(status, substate);
    const progress = state?.conversationProgress;
    const stage = state?.stage;
    // Tool-use-only bypass/goal indicators; workflow/process states report off.
    const toolUse = state && isToolUseState(state) ? state : null;
    const yoloActive = Boolean(toolUse?.toolEditBypass);
    const superYoloActive = Boolean(toolUse?.superYoloBypass);
    const goalActive = Boolean(toolUse?.goalActive);
    const goalStatus = toolUse?.goalStatus;
    const goalObjective = toolUse?.goalObjective ?? '';
    const hasExecutionId = Boolean(this.stream.executionId);
    const identity = this.stream.identity;
    const isNativeAgentRun = isPlainAgentIdentity(identity);
    const agentCategory = this.stream.agentCategory;
    // Identity decides the chrome: a non-agent run (process, multi-agent-
    // workflow container) gets the neutral toolbar even when a borrowed
    // agentCategory rides the live wire, and a pending stream (no identity,
    // no category) never gets a fabricated category's chrome.
    const isAgentOrPending =
      identity === undefined || identity.kind === 'agent';
    const toolbarButtons =
      isAgentOrPending && agentCategory
        ? TOOLBAR_BUTTONS[agentCategory]
        : NEUTRAL_TOOLBAR;
    const enabledButtons = displayKey
      ? ENABLED_BUTTONS_BY_DISPLAY_KEY[displayKey]
      : undefined;
    // Composed once per render: it both gates the copy button and is the
    // payload its click writes.
    const runContext = this.runContextText(this.stream, state);

    // Precompute per-button view metadata once. Only the tooltip is
    // active-state-aware; the accessible name stays constant because
    // `aria-pressed` already carries the toggle state — a name that swaps
    // with state announces a full sentence on every change (same rationale
    // as the wa-switch toggles in settingsView's ToolCard). The tooltips
    // live OUTSIDE <wa-button-group>: the group's rounded-corner styling
    // keys off ::slotted(:first-child)/(:last-child), so interleaving
    // tooltip nodes between the buttons would break those selectors —
    // `renderIconActionButtonParts` keeps them apart, and each anchors by
    // `for=${btn.id}` within this shadow root.
    const toolbarButtonViews = toolbarButtons.map((btn) => {
      const { disabled: computedDisabled, hidden } = this.getButtonState(
        btn,
        enabledButtons,
        hasExecutionId,
        isNativeAgentRun,
      );
      const isCopyRunContext = btn.localAction === 'copyRunContext';
      // Read-only trace-viewer export: no toolbar action reaches a live
      // backend — the onClick below re-checks `disabled` before
      // dispatching, so this one flag both looks and behaves inert.
      const disabled =
        this.archived ||
        computedDisabled ||
        (isCopyRunContext && runContext === '');
      const isActive = Boolean(
        btn.isToggle &&
        (btn.id === ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN
          ? superYoloActive
          : yoloActive),
      );
      // A tooltip only shows on hover, so the copy confirmation also swaps the
      // icon — same pairing as the external-inquiry copy button.
      const copied = isCopyRunContext && this.copyRunContext.state.copied;
      const restingTooltip =
        isActive && btn.titleActive ? btn.titleActive : btn.title;
      const tooltipText = copied
        ? this.copyRunContext.state.title
        : restingTooltip;
      const className = [
        btn.className,
        hidden ? 'toolbar-button--hidden' : undefined,
        isActive ? 'is-active' : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      const { button, tooltip } = renderIconActionButtonParts({
        id: btn.id,
        icon: copied ? 'check' : btn.icon,
        label: btn.label ?? btn.title,
        tooltip: tooltipText,
        className,
        size: 'm',
        disabled,
        // Toggle state gates auto-approval of edits/shell — expose it as
        // aria-pressed (toggles only; plain actions must not read as
        // toggle buttons).
        pressed: btn.isToggle ? isActive : undefined,
        ariaHidden: hidden,
        onClick: () => {
          if (disabled) return;
          if (isCopyRunContext) {
            void this.copyRunContext.copy(runContext);
            return;
          }
          // Non-local buttons all carry a command; the table pairs exactly one
          // of `command` / `localAction` with each entry.
          if (btn.command === undefined) return;
          this.dispatchEvent(
            ProgressEvents.toolbarCommand({ command: btn.command }),
          );
        },
      });
      return { id: btn.id, hidden, button, tooltip };
    });

    return html`
      <div class="log-header">
        <div class="header-left">
          ${this.renderParentLink()}
          <span
            id=${ELEMENT_IDS.ACTIVE_STREAM_NAME}
            data-stream=${this.stream.name}
          >
            ${streamDisplayLabel(this.stream)}
          </span>
          ${
            this.stream.label
              ? html`<wa-tooltip for=${ELEMENT_IDS.ACTIVE_STREAM_NAME}
                  >${this.stream.label} · ${this.stream.name}</wa-tooltip
                >`
              : nothing
          }
          <span
            id=${ELEMENT_IDS.STATUS_INDICATOR}
            role="img"
            aria-label=${statusLabel}
            class=${classMap({
              'status-indicator': true,
              ...(statusClass ? { [statusClass]: true } : {}),
            })}
          ></span>
          <wa-tooltip for=${ELEMENT_IDS.STATUS_INDICATOR}>
            ${statusLabel}
          </wa-tooltip>
          ${this.renderGoalChip(goalActive, goalStatus, goalObjective)}
          ${this.renderProgressBadge(progress, stage)}
        </div>
        <div class="header-actions">
          <wa-button-group
            id=${ELEMENT_IDS.TOOLBAR_CONTAINER}
            label="Stream actions"
            data-agent-mode=${agentCategory}
          >
            ${repeat(
              toolbarButtonViews,
              (view) => view.id,
              (view) => view.button,
            )}
          </wa-button-group>
          ${repeat(
            toolbarButtonViews.filter((view) => !view.hidden),
            (view) => view.id,
            (view) => view.tooltip,
          )}
        </div>
      </div>
    `;
  }

  private getButtonState(
    button: ProgressToolbarButton,
    enabledButtons: ReadonlySet<string> | undefined,
    hasExecutionId: boolean,
    isNativeAgentRun: boolean,
  ): { disabled: boolean; hidden: boolean } {
    // Same treatment as an execution-dependent button with no executionId:
    // hidden, not just disabled, so the toolbar never displays a control the
    // active host's registry has declared unsupported (or that this stream's
    // run identity does not support).
    const hidden =
      (EXECUTION_DEPENDENT_BUTTONS.has(button.id) && !hasExecutionId) ||
      (NATIVE_AGENT_ONLY_BUTTONS.has(button.id) && !isNativeAgentRun) ||
      // A local action has no backend command, so no host can declare it
      // unsupported.
      (button.command !== undefined &&
        isKnownUnsupported(this.unsupportedCommands, button.command));
    const disabled = hidden || !enabledButtons?.has(button.id);
    return { disabled, hidden };
  }

  private renderGoalChip(
    goalActive: boolean,
    goalStatus: GoalStatus | undefined,
    goalObjective: string,
  ): TemplateResult | typeof nothing {
    // `goalActive`/`goalStatus`/`goalObjective` are three independently-set
    // state fields (mirroring the wire/storage shape) — derive the canonical
    // "status/objective only meaningful when active" union once here rather
    // than guarding ad hoc.
    const goal = deriveGoalState({
      goalActive,
      goalStatus,
      goalObjective: goalObjective || undefined,
    });
    if (!goal.active) return nothing;
    const isPaused = goal.status === 'paused';
    const label = isPaused ? 'Goal paused' : 'Goal';
    const tooltip = goal.objective ? `${label}: ${goal.objective}` : label;
    return html`<wa-badge
        id=${ELEMENT_IDS.GOAL_CHIP}
        class="goal-chip"
        variant=${isPaused ? 'warning' : 'brand'}
        appearance="filled"
        aria-label=${tooltip}
      >
        ${waIcon('compass')} ${label}
      </wa-badge>
      <wa-tooltip for=${ELEMENT_IDS.GOAL_CHIP}>${tooltip}</wa-tooltip>`;
  }

  private renderProgressBadge(
    progress: ConversationProgress | undefined,
    stage: StreamStage | undefined,
  ): TemplateResult | typeof nothing {
    if (!stage && !progress?.toolCallCount) {
      return nothing;
    }
    const progressTitle = getProgressBadgeTitle(progress, stage);
    return html`<wa-tag
        id=${ELEMENT_IDS.PROGRESS_BADGE}
        class="progress-badge"
        variant="neutral"
        size="s"
      >
        ${waIcon('chart-line')} ${renderProgressBadgeContent(progress, stage)}
      </wa-tag>
      ${
        progressTitle
          ? html`<wa-tooltip for=${ELEMENT_IDS.PROGRESS_BADGE}
              >${progressTitle}</wa-tooltip
            >`
          : nothing
      }`;
  }

  private renderParentLink(): TemplateResult | typeof nothing {
    const parentStreamId = this.stream?.parentStreamId;
    if (!parentStreamId) return nothing;

    // The parent's own tab info owns its display label. A missing entry
    // means the parent tab was evicted while this child still references
    // it — fall back to a neutral label, never the raw
    // `agent#executionId` handle.
    const displayName =
      streamDisplayLabel(this.streamById.get(parentStreamId)) ??
      'Parent session';

    return html`
      <span
        id=${ELEMENT_IDS.PARENT_LINK}
        class="parent-link"
        role="button"
        tabindex="0"
        @click=${this.navigateToParent}
        @keydown=${this.handleParentLinkKey}
      >
        ${waIcon('arrow-left')}
        <span class="parent-link-label">${displayName}</span>
      </span>
      <wa-tooltip for=${ELEMENT_IDS.PARENT_LINK}
        >Go to parent: ${displayName} · ${parentStreamId}</wa-tooltip
      >
    `;
  }

  private handleParentLinkKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.navigateToParent();
    }
  }

  private navigateToParent(): void {
    const parentStreamId = this.stream?.parentStreamId;
    if (!parentStreamId) return;
    this.dispatchEvent(
      ProgressEvents.streamSwitch({ streamId: parentStreamId }),
    );
  }
}
