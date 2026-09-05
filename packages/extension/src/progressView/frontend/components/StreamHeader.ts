import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type {
  ConversationProgress,
  GoalState,
  StreamStage,
  StreamTabId,
} from '@shared/schemas';
import {
  isPlainAgentIdentity,
  STREAM_LIFECYCLE_UNAVAILABLE,
  STREAM_PHASE,
  STREAM_SUBSTATE,
} from '@shared/schemas';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { formatWorkflowRunContext } from '@shared/copy/workflowRunContext';
import { CopyButtonController } from '@shared/litControllers/CopyButtonController';
import {
  progressHeaderStatus,
  type StreamStatusDisplayKey,
} from '@shared/streams/streamStatusDisplay';
import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';
import { renderIconActionButtonParts } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import '@progressView/frontend/components/ToolTimer';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';

import {
  ELEMENT_IDS,
  NEUTRAL_TOOLBAR,
  TOOLBAR_BUTTONS,
  type ProgressToolbarButton,
} from '../constants';
import { toolbarToggleStyles } from '../styles/toolbarToggleStyles';
import {
  renderProgressBadgeContent,
  getProgressBadgeTitle,
} from '../formatters/progressBadgeFormatter';

const ACTIVE_STATE_BUTTONS = [
  ELEMENT_IDS.STOP_STREAM_BTN,
  ELEMENT_IDS.TOOL_EDIT_TOGGLE_BTN,
  ELEMENT_IDS.BASH_TOGGLE_BTN,
  ELEMENT_IDS.AUTO_TASK_TOGGLE_BTN,
  ELEMENT_IDS.COMPACT_RESPONSE_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
];

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

/** A stream this process cannot act on: read and export only. */
const READ_ONLY_BUTTONS = new Set<string>([
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
]);

const NOT_YET_RUN_BUTTONS = new Set<string>([
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.COPY_RUN_CONTEXT_BTN,
]);

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
  [STREAM_LIFECYCLE_UNAVAILABLE]: new Set(READ_ONLY_BUTTONS),
};

const NATIVE_AGENT_ONLY_BUTTONS = new Set([
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
]);

/** The status dot's hue per tone (G4: the fold spells the tone). */
const TONE_INDICATOR_CLASS: Record<StreamView['tone'], string> = {
  running: 'is-running',
  success: 'is-completed',
  danger: 'is-failed',
  warning: 'is-starting',
  neutral: 'is-ready',
};

/** Which toolbar buttons a stream's state licenses. */
function enabledToolbarButtons(
  stream: StreamView,
  displayKey: StreamStatusDisplayKey | undefined,
): ReadonlySet<string> | undefined {
  if (stream.readOnly) return READ_ONLY_BUTTONS;
  if (stream.group === 'interrupted') return new Set(TERMINAL_STATE_BUTTONS);
  return displayKey ? ENABLED_BUTTONS_BY_DISPLAY_KEY[displayKey] : undefined;
}

@customElement('stream-header')
export class StreamHeader extends LitElement {
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
        padding: var(--wa-space-2xs) var(--wa-space-m);
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
        min-width: 8ch;
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--wa-color-text-normal);
        font-size: var(--font-size);
        font-weight: var(--font-weight-semibold);
        line-height: 1.2;
        letter-spacing: -0.012em;
      }

      .status-label {
        flex: 0 0 auto;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
        white-space: nowrap;
      }

      tool-timer {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .header-actions {
        display: flex;
        justify-content: flex-end;
        flex: 0 0 auto;
        min-width: 0;
        max-width: 100%;
        margin-inline-start: auto;
        overflow-x: auto;
        overscroll-behavior-inline: contain;
        scrollbar-width: thin;
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

      /* Narrow, the whole toolbar folds behind one trailing icon (see the
         container query); wide, the toolbar is what the row shows. */
      .header-overflow {
        display: none;
      }

      .header-overflow-status {
        padding: var(--wa-space-2xs) var(--wa-space-s) var(--wa-space-3xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        white-space: nowrap;
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

      /* The ancestors path, root first. Segments are laid out in reverse DOM
         order so that when the path cannot fit, the root end is what the
         overflow clips: the nearest ancestor always survives (per-segment
         eviction). The title beside it takes the remaining width. */
      .ancestors {
        display: flex;
        flex-direction: row-reverse;
        justify-content: flex-start;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }
      .ancestor {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        flex: 0 1 auto;
        min-width: 0;
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        background: var(--wa-color-neutral-fill-quiet);
        border: none;
        border-radius: var(--border-radius-small);
        font: inherit;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
      }
      .ancestor-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .ancestor:hover {
        color: var(--color-text-link);
      }
      .ancestor:focus-visible {
        border-radius: var(--border-radius-small);
      }
      .ancestor-separator {
        flex: 0 0 auto;
        font-size: var(--font-size-xs);
        color: var(--color-text-muted);
      }
      :dir(rtl) .ancestor-separator {
        transform: scaleX(-1);
      }
      wa-tag.progress-badge wa-icon {
        font-size: var(--font-size-xs);
      }

      wa-tag.progress-badge {
        font-variant-numeric: tabular-nums;
      }

      :dir(rtl) .parent-link wa-icon {
        transform: scaleX(-1);
      }

      /* Below the wide width the eight-button toolbar cannot share the row
         with the path and the title, so it folds behind one trailing icon
         with the tool-calls count and the status label. */
      @container (max-width: 880px) {
        .status-label,
        wa-tag.progress-badge,
        .header-actions wa-button-group {
          display: none;
        }

        .log-header {
          padding-inline: var(--wa-space-xs);
        }

        .header-overflow {
          display: inline-flex;
        }
      }
    `,
  ];

  @property({ attribute: false }) stream: StreamView | null = null;
  /** For the per-run policy snapshot behind the bypass toggles. */
  @property({ attribute: false }) view: SessionView | null = null;

  private readonly copyRunContext = new CopyButtonController(this, {
    successTitle: 'Copied!',
  });

  private runContextText(stream: StreamView): string {
    if (stream.category !== 'workflow') return '';
    return formatWorkflowRunContext({
      stream: {
        name: stream.id,
        label: stream.label,
        model: stream.model ?? undefined,
        modelLabel: stream.modelLabel ?? undefined,
        executionId: stream.executionId,
        description: stream.description ?? undefined,
        creationTimestamp: stream.runStartedAt ?? 0,
        identity: stream.identity ?? undefined,
        agentCategory: stream.category,
      },
      files: stream.files,
      compileFailures: stream.compileFailures,
    });
  }

  /** The arm each toolbar button dispatches. */
  private dispatchToolbar(button: ProgressToolbarButton, stream: StreamView) {
    const streamId = stream.id;
    if (button.bypassKind !== undefined) {
      const enabled = !this.bypassActive(stream, button.bypassKind);
      this.dispatchEvent(
        SessionUiEvents.runtime({
          kind: 'policy.set',
          change: {
            field: 'bypass',
            streamId,
            bypass: button.bypassKind,
            enabled,
          },
        }),
      );
      return;
    }
    switch (button.id) {
      case ELEMENT_IDS.STOP_STREAM_BTN:
        this.dispatchEvent(
          SessionUiEvents.runtime({ kind: 'stream.stop', streamId }),
        );
        return;
      case ELEMENT_IDS.COMPACT_RESPONSE_BTN:
        this.dispatchEvent(
          SessionUiEvents.runtime({ kind: 'stream.compact', streamId }),
        );
        return;
      case ELEMENT_IDS.RESUME_BTN:
        this.dispatchEvent(SessionUiEvents.host({ kind: 'resume', streamId }));
        return;
      case ELEMENT_IDS.RUN_NEW_BTN:
        this.dispatchEvent(SessionUiEvents.host({ kind: 'runNew', streamId }));
        return;
      case ELEMENT_IDS.RESTORE_STATE_BTN:
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'restoreIntoLauncher', streamId }),
        );
        return;
      case ELEMENT_IDS.OPEN_TASK_STORAGE_BTN:
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'openTaskStorage', streamId }),
        );
        return;
      case ELEMENT_IDS.EXPORT_TRANSCRIPT_BTN:
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'exportTranscript', streamId }),
        );
        return;
      case ELEMENT_IDS.DIFF_STREAM_BTN:
        this.dispatchEvent(
          SessionUiEvents.host({ kind: 'latexdiff', streamId }),
        );
        return;
      case ELEMENT_IDS.CLEAN_STREAM_BTN:
        this.dispatchEvent(SessionUiEvents.host({ kind: 'clean', streamId }));
        return;
      case ELEMENT_IDS.PACK_STREAM_BTN:
        this.dispatchEvent(SessionUiEvents.host({ kind: 'pack', streamId }));
        return;
    }
  }

  private bypassActive(
    stream: StreamView,
    kind: NonNullable<ProgressToolbarButton['bypassKind']>,
  ): boolean {
    return this.view?.policy.get(stream.id)?.bypasses[kind] === true;
  }

  override render(): TemplateResult | typeof nothing {
    const stream = this.stream;
    if (!stream) return nothing;
    const { displayKey } = progressHeaderStatus(
      stream.status,
      stream.substate ?? undefined,
    );
    const statusLabel = stream.statusLabel;
    const goal: GoalState =
      stream.category === 'toolUse' ? stream.goal : { active: false };
    const identity = stream.identity;
    // An agent run takes its category's chrome; a legacy stream with no
    // identity, a process, or a workflow container takes the neutral one.
    const toolbarButtons =
      identity?.kind === 'agent'
        ? TOOLBAR_BUTTONS[stream.category]
        : NEUTRAL_TOOLBAR;
    // Resume, Run new, and Restore reach the host's `nativeAgentRun` gate,
    // which admits a plain agent identity and nothing else.
    const isNativeAgentRun = isPlainAgentIdentity(identity);
    const enabledButtons = enabledToolbarButtons(stream, displayKey);
    const runContext = this.runContextText(stream);
    const toolbarButtonViews = toolbarButtons.map((btn) => {
      const hidden = NATIVE_AGENT_ONLY_BUTTONS.has(btn.id) && !isNativeAgentRun;
      const isCopyRunContext = btn.localAction === 'copyRunContext';
      const disabled =
        hidden ||
        !enabledButtons?.has(btn.id) ||
        (isCopyRunContext && runContext === '');
      const isActive =
        btn.bypassKind !== undefined &&
        this.bypassActive(stream, btn.bypassKind);
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
      const activate = (): void => {
        if (disabled) return;
        if (isCopyRunContext) {
          void this.copyRunContext.copy(runContext);
          return;
        }
        this.dispatchToolbar(btn, stream);
      };
      const { button, tooltip } = renderIconActionButtonParts({
        id: btn.id,
        icon: copied ? 'check' : btn.icon,
        label: btn.label ?? btn.title,
        tooltip: tooltipText,
        className,
        size: 'm',
        disabled,
        pressed: btn.bypassKind === undefined ? undefined : isActive,
        ariaHidden: hidden,
        onClick: activate,
      });
      // The same action as one menu row, for the folded toolbar.
      const item = html`<wa-dropdown-item
        value=${btn.id}
        type=${btn.bypassKind === undefined ? 'normal' : 'checkbox'}
        ?checked=${isActive}
        ?disabled=${disabled}
        >${waIcon(copied ? 'check' : btn.icon, { slot: 'icon' })}${
          btn.label ?? restingTooltip
        }</wa-dropdown-item
      >`;
      return { id: btn.id, hidden, button, tooltip, item, activate };
    });
    const shownButtons = toolbarButtonViews.filter((view) => !view.hidden);
    const progressTitle = getProgressBadgeTitle(
      stream.conversationProgress,
      stream.stage ?? undefined,
    );

    return html`
      <div class="log-header">
        <div class="header-left">
          ${this.renderAncestors(stream)}
          <h1 id=${ELEMENT_IDS.ACTIVE_STREAM_NAME} data-stream=${stream.id}>
            ${stream.label}
          </h1>
          <wa-tooltip for=${ELEMENT_IDS.ACTIVE_STREAM_NAME}
            >${stream.description ?? stream.label} · ${stream.id}</wa-tooltip
          >
          <span
            id=${ELEMENT_IDS.STATUS_INDICATOR}
            role="img"
            aria-label=${statusLabel}
            class=${classMap({
              'status-indicator': true,
              [TONE_INDICATOR_CLASS[stream.tone]]: true,
            })}
          ></span>
          <wa-tooltip for=${ELEMENT_IDS.STATUS_INDICATOR}>
            ${stream.statusDetail ?? statusLabel}
          </wa-tooltip>
          <span class="status-label" aria-hidden="true">${statusLabel}</span>
          ${this.renderRunElapsed(stream)} ${this.renderGoalChip(goal)}
          ${this.renderProgressBadge(stream.conversationProgress, stream.stage)}
        </div>
        <div class="header-actions">
          <wa-button-group
            id=${ELEMENT_IDS.TOOLBAR_CONTAINER}
            label="Stream actions"
          >
            ${repeat(
              toolbarButtonViews,
              (view) => view.id,
              (view) => view.button,
            )}
          </wa-button-group>
          ${repeat(
            shownButtons,
            (view) => view.id,
            (view) => view.tooltip,
          )}
          <wa-dropdown
            class="header-overflow"
            placement="bottom-end"
            @wa-select=${(event: Event) => {
              const value = (
                event as CustomEvent<{ item?: { value?: unknown } }>
              ).detail?.item?.value;
              shownButtons.find((view) => view.id === value)?.activate();
            }}
          >
            <wa-button
              slot="trigger"
              id=${ELEMENT_IDS.HEADER_MORE_BTN}
              class="action-icon-button"
              appearance="plain"
              variant="neutral"
              size="s"
              type="button"
              aria-label="Stream actions"
              >${waIcon('ellipsis')}</wa-button
            >
            <div class="header-overflow-status">
              ${statusLabel}${progressTitle ? ` · ${progressTitle}` : ''}
            </div>
            ${repeat(
              shownButtons,
              (view) => view.id,
              (view) => view.item,
            )}
          </wa-dropdown>
          <wa-tooltip for=${ELEMENT_IDS.HEADER_MORE_BTN}
            >Stream actions</wa-tooltip
          >
        </div>
      </div>
    `;
  }

  private renderGoalChip(goal: GoalState): TemplateResult | typeof nothing {
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

  private renderRunElapsed(
    stream: StreamView,
  ): TemplateResult | typeof nothing {
    if (stream.runStartedAt === null || stream.group === 'recent') {
      return nothing;
    }
    return html`<tool-timer
      id=${ELEMENT_IDS.RUN_ELAPSED}
      .startTime=${stream.runStartedAt}
    ></tool-timer>`;
  }

  private renderProgressBadge(
    progress: ConversationProgress | undefined,
    stage: StreamStage | null,
  ): TemplateResult | typeof nothing {
    const stageValue = stage ?? undefined;
    if (!stageValue && !progress?.toolCallCount) {
      return nothing;
    }
    const progressTitle = getProgressBadgeTitle(progress, stageValue);
    return html`<wa-tag
        id=${ELEMENT_IDS.PROGRESS_BADGE}
        class="progress-badge"
        variant="neutral"
        size="s"
      >
        ${waIcon('chart-line')}
        ${renderProgressBadgeContent(progress, stageValue)}
      </wa-tag>
      ${
        progressTitle
          ? html`<wa-tooltip for=${ELEMENT_IDS.PROGRESS_BADGE}
              >${progressTitle}</wa-tooltip
            >`
          : nothing
      }`;
  }

  /** The full ancestors path, root first, each segment a link to that
   *  stream. Laid out nearest-first in the DOM (see the styles). */
  private renderAncestors(stream: StreamView): TemplateResult | typeof nothing {
    if (stream.ancestors.length === 0) return nothing;
    const nearestFirst = [...stream.ancestors].reverse();
    return html`
      <nav class="ancestors" aria-label="Parent sessions">
        ${repeat(
          nearestFirst,
          (ancestor) => ancestor.id,
          (ancestor, index) => html`
            <span class="ancestor-separator" aria-hidden="true"
              >${waIcon('chevron-right')}</span
            >
            <button
              type="button"
              class="ancestor"
              id=${`ancestor-${index}`}
              aria-label=${`Go to ${ancestor.label}`}
              @click=${() => this.navigateTo(ancestor.id)}
            >
              <span class="ancestor-label">${ancestor.label}</span>
            </button>
            <wa-tooltip for=${`ancestor-${index}`}
              >Go to ${ancestor.label} · ${ancestor.id}</wa-tooltip
            >
          `,
        )}
      </nav>
    `;
  }

  private navigateTo(streamId: StreamTabId): void {
    this.dispatchEvent(SessionUiEvents.surface({ kind: 'select', streamId }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-header': StreamHeader;
  }
}
