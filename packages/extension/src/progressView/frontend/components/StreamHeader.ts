// Third-party imports
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
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
  STREAM_STATUS,
  type ConversationProgress,
  type StreamTabInfo,
} from '@shared/schemas';
import { statusIndicatorStyles } from '@shared/styles/statusIndicatorStyles';
import { type TeXRAIconName, waIcon } from '@shared/wa/webAwesomeIcons';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - progress view constants
import { ELEMENT_IDS, TOOLBAR_BUTTONS } from '../constants';
import { ProgressEvents } from '../events';
import { getComposedPathElement } from '../utils';
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

/** Status display labels - extracted as constant to avoid recreation on each render */
const STATUS_LABELS: Record<string, string> = {
  [STREAM_STATUS.RUNNING]: 'Running',
  [STREAM_STATUS.ERROR]: 'Error',
  [STREAM_STATUS.STOPPED]: 'Stopped',
  [STREAM_STATUS.READY]: 'Ready',
  [STREAM_STATUS.WAITING]: 'Waiting for follow-up',
  [STREAM_STATUS.RESUMING]: 'Resuming',
  [STREAM_STATUS.INITIALIZING]: 'Initializing',
};

/**
 * Buttons enabled per status - pre-computed as Sets to avoid
 * allocating a new Set on every getButtonState() call during render.
 */
const ENABLED_BUTTONS_BY_STATUS: Record<string, Set<string>> = {
  [STREAM_STATUS.INITIALIZING]: new Set([
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.CLEAN_STREAM_BTN,
  ]),
  [STREAM_STATUS.RUNNING]: new Set([
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.YOLO_TOGGLE_BTN,
    ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
    ELEMENT_IDS.ODYSSEY_TOGGLE_BTN,
    ELEMENT_IDS.COMPACT_RESPONSE_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ]),
  [STREAM_STATUS.ERROR]: new Set([
    ELEMENT_IDS.RUN_NEW_BTN,
    ELEMENT_IDS.RESUME_BTN,
    ELEMENT_IDS.PACK_STREAM_BTN,
    ELEMENT_IDS.CLEAN_STREAM_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.DIFF_STREAM_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ]),
  [STREAM_STATUS.STOPPED]: new Set([
    ELEMENT_IDS.RUN_NEW_BTN,
    ELEMENT_IDS.RESUME_BTN,
    ELEMENT_IDS.PACK_STREAM_BTN,
    ELEMENT_IDS.CLEAN_STREAM_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.DIFF_STREAM_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ]),
  [STREAM_STATUS.READY]: new Set([
    ELEMENT_IDS.RUN_NEW_BTN,
    ELEMENT_IDS.PACK_STREAM_BTN,
    ELEMENT_IDS.CLEAN_STREAM_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.DIFF_STREAM_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ]),
  [STREAM_STATUS.WAITING]: new Set([
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.YOLO_TOGGLE_BTN,
    ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
    ELEMENT_IDS.ODYSSEY_TOGGLE_BTN,
    ELEMENT_IDS.COMPACT_RESPONSE_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ]),
  [STREAM_STATUS.RESUMING]: new Set([
    ELEMENT_IDS.STOP_STREAM_BTN,
    ELEMENT_IDS.YOLO_TOGGLE_BTN,
    ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN,
    ELEMENT_IDS.ODYSSEY_TOGGLE_BTN,
    ELEMENT_IDS.COMPACT_RESPONSE_BTN,
    ELEMENT_IDS.RESTORE_STATE_BTN,
    ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ]),
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
    css`
      :host {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .log-header {
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        font-size: var(--font-size-sm);
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
        color: var(--color-text-secondary);
        border-bottom: var(--border-thin) solid var(--color-border);
      }

      .log-header__primary {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--wa-space-xs);
        flex: 1;
        min-width: 0;
      }

      .stream-header {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        min-width: 0;
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
        flex-shrink: 0;
        margin-left: auto;
      }

      /* Status indicator overrides - base styles from statusIndicatorStyles */
      .status-indicator {
        width: var(--wa-space-xs);
        height: var(--wa-space-xs);
        margin: 0 var(--wa-space-2xs);
        position: relative;
      }

      /* Tooltip on hover */
      .status-indicator::after {
        content: attr(data-status);
        position: absolute;
        left: 50%;
        top: 100%;
        transform: translateX(-50%);
        margin-top: var(--wa-space-3xs);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        background: var(--background-color);
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius-small);
        font-size: var(--font-size-sm);
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity var(--transition-normal);
        z-index: 100;
      }

      .status-indicator:hover::after {
        opacity: var(--opacity-full);
      }

      /* Note: .is-ready and other status states from statusIndicatorStyles */

      /* Replaces flex layout previously provided by vscode-toolbar-container.
         Without this, toolbar buttons would stack vertically in block flow. */
      .toolbar-container {
        display: inline-flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs, 4px);
        align-items: center;
      }

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

      /* Shared toggle button base */
      .yolo-toggle-button,
      .super-yolo-toggle-button,
      .odyssey-toggle-button {
        flex-shrink: 0;
      }

      .yolo-toggle-button.is-active,
      .super-yolo-toggle-button.is-active,
      .odyssey-toggle-button.is-active {
        border-radius: var(--border-radius);
      }

      /* Toggle color per variant */
      .yolo-toggle-button.is-active {
        --_toggle-color: var(--color-error);
      }

      .super-yolo-toggle-button.is-active {
        --_toggle-color: var(--color-warning);
      }

      .odyssey-toggle-button.is-active {
        --_toggle-color: var(--color-info, var(--wa-color-brand-fill-loud));
      }

      /* Active toggle: color + tinted background. */
      :is(
        .yolo-toggle-button,
        .super-yolo-toggle-button,
        .odyssey-toggle-button
      ).is-active {
        color: var(--_toggle-color);
        background-color: color-mix(
          in srgb,
          var(--_toggle-color) 15%,
          transparent
        );
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
        outline-offset: 1px;
        border-radius: var(--border-radius-small);
      }

      .parent-link wa-icon {
        font-size: var(--font-size-xs);
      }

      wa-tag.progress-badge wa-icon {
        font-size: var(--font-size-xs);
      }

      @media (max-width: 500px) {
        .log-header {
          flex-wrap: wrap;
          gap: var(--wa-space-2xs);
        }

        .header-left {
          flex-basis: 100%;
        }

        .header-actions {
          margin-left: auto;
        }
      }
    `,
  ];

  @property({ attribute: false }) stream: StreamTabInfo | null = null;
  @property({ attribute: false }) status: string = STREAM_STATUS.READY;
  @property({ attribute: false }) progress: ConversationProgress | undefined;
  @property({ attribute: false }) yoloActive = false;
  @property({ attribute: false }) superYoloActive = false;
  @property({ attribute: false }) odysseyActive = false;

  override render(): TemplateResult | typeof nothing {
    if (!this.stream) {
      return nothing;
    }

    const status = this.status || STREAM_STATUS.READY;
    const statusLabel = STATUS_LABELS[status] ?? status;
    const hasExecutionId = Boolean(this.stream.executionId);
    const agentCategory = this.stream.agentCategory;
    const toolbarButtons =
      TOOLBAR_BUTTONS[agentCategory] ?? TOOLBAR_BUTTONS.workflow;

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
                [`is-${status}`]: Boolean(status),
              })}
              data-status=${statusLabel}
            ></span>
            ${this.renderProgressBadge()}
          </div>
          <div class="header-actions">
            <div
              id=${ELEMENT_IDS.TOOLBAR_CONTAINER}
              class="toolbar-container"
              data-agent-mode=${agentCategory}
              @click=${this.handleToolbarClick}
            >
              ${repeat(
                toolbarButtons as ToolbarButton[],
                (btn) => btn.id,
                (btn) => {
                  const { disabled, hidden } = this.getButtonState(
                    btn.id,
                    status,
                    hasExecutionId,
                  );
                  const isActive = Boolean(
                    btn.isToggle &&
                    (btn.id === ELEMENT_IDS.SUPER_YOLO_TOGGLE_BTN
                      ? this.superYoloActive
                      : btn.id === ELEMENT_IDS.ODYSSEY_TOGGLE_BTN
                        ? this.odysseyActive
                        : this.yoloActive),
                  );
                  const title =
                    isActive && btn.titleActive ? btn.titleActive : btn.title;
                  const classes = classMap({
                    'action-icon-button': true,
                    ...(btn.className ? { [btn.className]: true } : {}),
                    'toolbar-button--hidden': hidden,
                    'is-active': isActive,
                  });
                  return html`
                    <wa-button
                      id=${btn.id}
                      class=${classes}
                      appearance="plain"
                      variant="neutral"
                      size="small"
                      type="button"
                      aria-label=${title}
                      title=${title}
                      data-command=${btn.command}
                      aria-hidden=${hidden ? 'true' : 'false'}
                      ?disabled=${disabled}
                    >
                      ${waIcon(btn.icon as TeXRAIconName)}
                    </wa-button>
                  `;
                },
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private getButtonState(
    buttonId: string,
    status: string,
    hasExecutionId: boolean,
  ): { disabled: boolean; hidden: boolean } {
    const enabledButtons = ENABLED_BUTTONS_BY_STATUS[status];
    const hidden = EXECUTION_DEPENDENT_BUTTONS.has(buttonId) && !hasExecutionId;
    const disabled = hidden || !enabledButtons?.has(buttonId);
    return { disabled, hidden };
  }

  private renderProgressBadge(): TemplateResult | typeof nothing {
    if (!this.progress?.conversationTurns) return nothing;
    return html`<wa-tag
      class="progress-badge"
      variant="neutral"
      size="small"
      title=${ifDefined(getProgressBadgeTitle(this.progress))}
    >
      <wa-icon library="texra" name="pulse" aria-hidden="true"></wa-icon>
      ${renderProgressBadgeContent(this.progress)}
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
        <wa-icon library="texra" name="arrow-left" aria-hidden="true"></wa-icon>
        ${displayName}
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

  private handleToolbarClick(event: MouseEvent) {
    const button = getComposedPathElement<HTMLElement>(event, '[data-command]');
    if (!button || button.hasAttribute('disabled')) return;

    const command = button.dataset.command;
    if (!command) return;

    this.dispatchEvent(ProgressEvents.toolbarCommand({ command }));
  }
}
