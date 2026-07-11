// Third-party imports
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import {
  designTokens,
  animationStyles,
  commonViewStyles,
} from '@shared/styles';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type ConversationProgress,
  type RoundStage,
  type StreamSubstate,
  type StreamTabInfo,
} from '@shared/schemas';
import {
  formatStreamStatusLabel,
  streamStatusDisplayKey,
  streamStatusIndicatorClass,
  type StreamStatusDisplayKey,
} from '@shared/streams/streamStatusDisplay';
import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';
import { isKnownUnsupported } from '@shared/utils/dispatcher';
import { renderIconActionButtonParts } from '@shared/wa/actionButtons';
import { type TeXRAIconName, waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';

// Local imports - progress view constants
import { ELEMENT_IDS, TOOLBAR_BUTTONS } from '../constants';
import { archivedContext } from '../contexts/streamContexts';
import { ProgressEvents } from '../events';
import { toolbarToggleStyles } from '../styles/toolbarToggleStyles';
import {
  renderProgressBadgeContent,
  getProgressBadgeTitle,
} from '../formatters/progressBadgeFormatter';

interface ToolbarButton {
  id: string;
  icon: string;
  command: string;
  title: string;
  titleActive?: string;
  className?: string;
  disabled?: boolean;
  isToggle?: boolean;
}

/**
 * Buttons enabled while a run is active (running / waiting / resuming): stop
 * plus the live-session controls (bypass toggles, compact, restore, storage).
 */
const ACTIVE_STATE_BUTTONS = [
  ELEMENT_IDS.STOP_STREAM_BTN,
  ELEMENT_IDS.YOLO_TOGGLE_BTN,
  ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
  ELEMENT_IDS.COMPACT_RESPONSE_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
];

/**
 * Buttons enabled in every terminal (finished) state — failed / completed /
 * cancelled: the run is over, so re-run, resume, archive, diff, and restore
 * are all available.
 */
const TERMINAL_STATE_BUTTONS = [
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.PACK_STREAM_BTN,
  ELEMENT_IDS.CLEAN_STREAM_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.DIFF_STREAM_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
];

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
  // 'ready' is the terminal set minus resume — there is no prior run to
  // resume before the stream has started for the first time.
  ready: new Set(
    TERMINAL_STATE_BUTTONS.filter((id) => id !== ELEMENT_IDS.RESUME_BTN),
  ),
  [STREAM_PHASE.WAITING]: new Set(ACTIVE_STATE_BUTTONS),
  [STREAM_SUBSTATE.RESUMING]: new Set(ACTIVE_STATE_BUTTONS),
};

/** Buttons that depend on having an executionId */
const EXECUTION_DEPENDENT_BUTTONS = new Set([
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.RESUME_BTN,
]);

@customElement('stream-header')
export class StreamHeader extends LitElement {
  static override styles = [
    designTokens,
    animationStyles,
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

      :host([hidden]) {
        display: none;
      }

      .log-header {
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        font-size: var(--font-size-sm);
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: var(--wa-space-2xs);
        min-height: var(--height-header);
        box-sizing: border-box;
        min-width: 0;
        max-width: 100%;
        color: var(--color-text-secondary);
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .log-header__primary {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        width: 100%;
        min-width: 0;
        max-width: 100%;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        flex: 1;
        min-width: 0;
        max-width: 100%;
      }

      .stream-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        flex: 1 1 auto;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
      }

      .stream-header #activeStreamName {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--wa-color-text-normal);
        font-weight: var(--font-weight-medium);
        letter-spacing: -0.005em;
      }

      .header-actions {
        display: flex;
        justify-content: flex-end;
        flex: 0 0 auto;
        min-width: 0;
        max-width: 100%;
        margin-left: auto;
      }

      .header-actions wa-button-group {
        max-width: 100%;
      }

      /* Status indicator overrides - base styles from statusIndicatorStyles.
         The hover label is a native <wa-tooltip> anchored to this dot via
         its "for" attribute. */
      .status-indicator {
        width: var(--wa-space-xs);
        height: var(--wa-space-xs);
        margin: 0 var(--wa-space-2xs);
      }

      /* Note: .is-ready and other status states from statusIndicatorStyles */

      .toolbar-button--hidden {
        display: none;
      }

      /* Button type styles */
      .stop-button {
        margin-right: var(--wa-space-3xs);
        color: var(--color-error);
      }

      .pack-button {
        margin-left: var(--wa-space-3xs);
      }

      .run-button {
        margin-left: var(--wa-space-3xs);
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
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        cursor: pointer;
        white-space: nowrap;
        border-radius: var(--border-radius-small);
      }

      .parent-link:hover {
        color: var(--color-text-link);
      }

      .parent-link:focus-visible {
        outline: var(--border-thin) solid var(--wa-color-focus);
        outline-offset: var(--border-thin);
        border-radius: var(--border-radius-small);
      }

      .parent-link wa-icon {
        font-size: var(--font-size-xs);
      }

      wa-tag.progress-badge wa-icon {
        font-size: var(--font-size-xs);
      }

      @container (max-width: 320px) {
        .log-header__primary {
          flex-wrap: wrap;
        }

        .header-left {
          flex-basis: 100%;
        }

        .header-actions {
          width: 100%;
          margin-left: 0;
        }
      }
    `,
  ];

  @property({ attribute: false }) stream: StreamTabInfo | null = null;
  @property({ attribute: false }) status: string = STREAM_STATUS.READY;
  @property({ attribute: false }) substate: StreamSubstate | undefined;
  @property({ attribute: false }) progress: ConversationProgress | undefined;
  @property({ attribute: false }) roundStage: RoundStage | undefined;
  @property({ attribute: false }) yoloActive = false;
  @property({ attribute: false }) superYoloActive = false;
  @property({ attribute: false }) goalActive = false;
  @property({ attribute: false }) goalStatus = '';
  @property({ attribute: false }) goalObjective = '';
  /**
   * Commands the active host's registry declares `unsupported(...)` (derived
   * from `unsupportedProgressCommands$`, itself derived from the host's
   * registry — see `@shared/utils/dispatcher`). A button whose command is in
   * this set is hidden, the same as an execution-dependent button with no
   * executionId, rather than rendered disabled-but-visible. `null` before
   * the host's one-shot capability broadcast arrives — see
   * `isKnownUnsupported`, which treats that the same as "unsupported" so a
   * button never flashes visible then hidden.
   */
  @property({ attribute: false })
  unsupportedCommands: ReadonlySet<string> | null = null;

  /** Read-only trace-viewer export: no toolbar action reaches a live backend. */
  @consume({ context: archivedContext, subscribe: true })
  private archived = false;

  override render(): TemplateResult | typeof nothing {
    if (!this.stream) {
      return nothing;
    }

    const status = this.status || STREAM_STATUS.READY;
    const statusLabel = formatStreamStatusLabel(status, {
      style: 'progressHeader',
      ...(this.substate ? { substate: this.substate } : {}),
    });
    const statusClass = streamStatusIndicatorClass(status, this.substate);
    const hasExecutionId = Boolean(this.stream.executionId);
    const agentCategory = this.stream.agentCategory;
    const toolbarButtons =
      TOOLBAR_BUTTONS[agentCategory] ?? TOOLBAR_BUTTONS.workflow;

    // Precompute per-button view metadata once so the button-group and the
    // sibling <wa-tooltip> elements share the same active-state-aware title.
    // The tooltips live OUTSIDE <wa-button-group>: the group's rounded-corner
    // styling keys off ::slotted(:first-child)/(:last-child), so interleaving
    // tooltip nodes between the buttons would break those selectors —
    // `renderIconActionButtonParts` keeps them apart, and each anchors by
    // `for=${btn.id}` within this shadow root.
    const toolbarButtonViews = (toolbarButtons as ToolbarButton[]).map(
      (btn) => {
        const { disabled: computedDisabled, hidden } = this.getButtonState(
          btn.id,
          btn.command,
          status,
          this.substate,
          hasExecutionId,
        );
        // Read-only trace-viewer export: no toolbar action reaches a live
        // backend — the onClick below re-checks `disabled` before
        // dispatching, so this one flag both looks and behaves inert.
        const disabled = this.archived || computedDisabled;
        const isActive = Boolean(
          btn.isToggle &&
          (btn.id === ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN
            ? this.superYoloActive
            : this.yoloActive),
        );
        const title = isActive && btn.titleActive ? btn.titleActive : btn.title;
        const className = [
          btn.className,
          hidden ? 'toolbar-button--hidden' : undefined,
          isActive ? 'is-active' : undefined,
        ]
          .filter(Boolean)
          .join(' ');
        const { button, tooltip } = renderIconActionButtonParts({
          id: btn.id,
          icon: btn.icon as TeXRAIconName,
          label: title,
          tooltip: title,
          className,
          disabled,
          ariaHidden: hidden,
          onClick: () => {
            if (disabled) return;
            this.dispatchEvent(
              ProgressEvents.toolbarCommand({ command: btn.command }),
            );
          },
        });
        return { id: btn.id, hidden, button, tooltip };
      },
    );

    return html`
      <div class="log-header">
        <div class="log-header__primary">
          <div class="header-left">
            ${this.renderParentLink()}
            <div class="stream-header">
              <span
                id=${ELEMENT_IDS.ACTIVE_STREAM_NAME}
                data-stream=${this.stream.name}
                title=${ifDefined(this.stream.label || undefined)}
              >
                ${this.stream.label || this.stream.name}
              </span>
            </div>
            <span
              id=${ELEMENT_IDS.STATUS_INDICATOR}
              class=${classMap({
                'status-indicator': true,
                ...(statusClass ? { [statusClass]: true } : {}),
              })}
            ></span>
            <wa-tooltip for=${ELEMENT_IDS.STATUS_INDICATOR}>
              ${statusLabel}
            </wa-tooltip>
            ${this.renderGoalChip()} ${this.renderProgressBadge()}
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
      </div>
    `;
  }

  private getButtonState(
    buttonId: string,
    command: string,
    status: string,
    substate: StreamSubstate | undefined,
    hasExecutionId: boolean,
  ): { disabled: boolean; hidden: boolean } {
    const displayKey = streamStatusDisplayKey(status, substate);
    const enabledButtons = displayKey
      ? ENABLED_BUTTONS_BY_DISPLAY_KEY[displayKey]
      : undefined;
    // Same treatment as an execution-dependent button with no executionId:
    // hidden, not just disabled, so the toolbar never displays a control the
    // active host's registry has declared unsupported.
    const hidden =
      (EXECUTION_DEPENDENT_BUTTONS.has(buttonId) && !hasExecutionId) ||
      isKnownUnsupported(this.unsupportedCommands, command);
    const disabled = hidden || !enabledButtons?.has(buttonId);
    return { disabled, hidden };
  }

  private renderGoalChip(): TemplateResult | typeof nothing {
    if (!this.goalActive) return nothing;
    const isPaused = this.goalStatus === 'paused';
    const label = isPaused ? 'Goal paused' : 'Goal';
    const tooltip = this.goalObjective
      ? `${label}: ${this.goalObjective}`
      : label;
    return html`<wa-badge
      class="goal-chip"
      variant=${isPaused ? 'warning' : 'brand'}
      appearance="filled"
      title=${tooltip}
      aria-label=${tooltip}
    >
      ${waIcon('compass')} ${label}
    </wa-badge>`;
  }

  private renderProgressBadge(): TemplateResult | typeof nothing {
    if (!this.roundStage && !this.progress?.toolCallCount) return nothing;
    return html`<wa-tag
      class="progress-badge"
      variant="neutral"
      size="small"
      title=${ifDefined(getProgressBadgeTitle(this.progress, this.roundStage))}
    >
      ${waIcon('pulse')}
      ${renderProgressBadgeContent(this.progress, this.roundStage)}
    </wa-tag>`;
  }

  private renderParentLink(): TemplateResult | typeof nothing {
    const parentStreamId = this.stream?.parentStreamId;
    if (!parentStreamId) return nothing;

    // Extract agent name from stream ID (format: "agentName@timestamp")
    const rawName = parentStreamId.split('@')[0];
    // Strip source prefix (e.g., "builtin:assistant" → "assistant")
    const colonIdx = rawName.indexOf(':');
    const displayName = colonIdx !== -1 ? rawName.slice(colonIdx + 1) : rawName;

    return html`
      <span
        class="parent-link"
        title="Go to parent: ${displayName}"
        @click=${this.navigateToParent}
      >
        ${waIcon('arrow-left')} ${displayName}
      </span>
    `;
  }

  private navigateToParent(): void {
    const parentStreamId = this.stream?.parentStreamId;
    if (!parentStreamId) return;
    this.dispatchEvent(
      ProgressEvents.streamSwitch({ streamId: parentStreamId }),
    );
  }
}
