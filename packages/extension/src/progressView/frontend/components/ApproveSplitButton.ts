/** Approve control with optional stream-scoped approval actions. */

// Third-party imports
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles + helpers
import { commonViewStyles, designTokens } from '@shared/styles';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';
import { createEvent } from '@shared/utils/events';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/** Internal dropdown-item value for the edit/bash session-bypass entry. */
const YOLO_VALUE = 'approve-session';
/** Internal dropdown-item value for the delegated-task approval entry. */
const DELEGATED_WORK_VALUE = 'approve-all-delegated-work';

/**
 * Approve control for approval prompts, used declaratively:
 *
 *   <approve-split-button
 *     .approveTitle=${title}
 *     .canBypass=${canBypass}
 *     @approve=${onApprove}
 *     @approve-session=${onYolo}
 *   ></approve-split-button>
 *
 * With no bypass flags it renders a plain Approve button. When `canBypass`
 * (edit/bash prompts) or `canApproveAllDelegatedWork` (agent proposals) is set
 * it becomes a
 * split button: the main click emits `approve`; the ▾ caret opens a menu whose
 * "Yolo (this session)" item emits `approve-session` and whose delegated-work
 * item emits `approve-all-delegated-work`. Selection is handled via Web
 * Awesome's `wa-select` (Enter/Space dispatch `wa-select`, not a DOM click on
 * the item), so the menu stays keyboard-accessible. Layout/colors are scoped
 * here; the host is width-capped to match the `.action-button` rule in
 * `requestPanelSharedStyles` (#6658) so Approve stays button-sized like its
 * siblings.
 */
@customElement('approve-split-button')
export class ApproveSplitButton extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      /* Mirror the .action-button cap (requestPanelSharedStyles, #6658): hug content
         and width-cap so Approve stays button-sized instead of growing to fill
         the action row like its Reject/Setup siblings. min-width: auto keeps the
         label (plus caret) from clipping. */
      :host {
        display: inline-flex;
        flex: 0 1 auto;
        min-width: auto;
        max-width: min(14rem, 100%);
      }

      .approve-split-main {
        flex: 1 1 auto;
        min-width: 0;
      }

      .approve-split-main::part(base) {
        width: 100%;
        justify-content: center;
        color: var(--wa-color-success-fill-loud);
      }

      .approve-split {
        position: relative;
        display: inline-flex;
        align-items: stretch;
        width: 100%;
        min-width: 0;
      }

      /* Square the inner corners so the label and caret fuse into one pill. */
      .approve-split .approve-split-main::part(base) {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
      }

      /* Pull the caret onto the label so their 1px borders overlap into a
         single divider (instead of a doubled line) once they appear on hover. */
      .approve-split-menu {
        flex: 0 0 auto;
        display: inline-flex;
        margin-left: calc(-1 * var(--border-thin));
      }

      .approve-split-trigger {
        flex: 0 0 auto;
        width: 1.5rem;
        min-width: 1.5rem;
      }

      /* Match the .action-button chrome: borderless at rest with the border
         reserved (transparent) so nothing shifts, the caret at full presence
         (success color, not the faint icon-button default), and only the right
         corners rounded so it tucks against the label. */
      .approve-split-trigger::part(base) {
        min-height: var(--height-control-compact);
        height: auto;
        width: 100%;
        padding: 0;
        opacity: var(--opacity-full);
        color: var(--wa-color-success-fill-loud);
        background: transparent;
        border: var(--border-thin) solid transparent;
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
      }

      .approve-split-trigger::part(base):hover {
        background: transparent;
      }

      .approve-split-trigger wa-icon {
        font-size: var(--font-size-sm);
      }

      /* Hovering or opening either half outlines the whole pair as one box with
         a single internal divider, so the caret reads as Approve's menu rather
         than a stray glyph floating beside the button. */
      .approve-split:hover .approve-split-main::part(base),
      .approve-split:hover .approve-split-trigger::part(base),
      .approve-split:focus-within .approve-split-main::part(base),
      .approve-split:focus-within .approve-split-trigger::part(base),
      .approve-split wa-dropdown[open] .approve-split-main::part(base),
      .approve-split wa-dropdown[open] .approve-split-trigger::part(base) {
        border-color: var(--wa-color-surface-border, var(--color-border));
      }

      .approve-split-trigger:focus-visible::part(base) {
        outline: var(--border-thin) solid var(--wa-color-focus);
        outline-offset: var(--border-thin);
      }

      .approve-split wa-dropdown[open] .approve-split-trigger wa-icon {
        transform: rotate(180deg);
      }
    `,
  ];

  /** Tooltip / aria-label for the main Approve button. */
  @property({ attribute: false }) approveTitle = '';

  /** When true, surface the edit/bash "Yolo (this session)" menu item. */
  @property({ type: Boolean }) canBypass = false;

  /** When true, surface the proposal's stream-scoped approve-all action. */
  @property({ type: Boolean }) canApproveAllDelegatedWork = false;

  /** Read-only trace-viewer export: render inert, no bypass split-menu. */
  @property({ type: Boolean }) disabled = false;

  override render(): TemplateResult {
    const approveButton = renderLabeledActionButton({
      icon: 'check',
      text: 'Approve',
      title: this.approveTitle,
      action: 'approve',
      className: 'approve-split-main',
      disabled: this.disabled,
      onClick: () => this.emit('approve'),
    });
    if (
      this.disabled ||
      (!this.canBypass && !this.canApproveAllDelegatedWork)
    ) {
      return approveButton;
    }
    return html`
      <div class="approve-split">
        ${approveButton}
        <wa-dropdown
          class="approve-split-menu"
          placement="bottom-end"
          @wa-select=${this.handleSelect}
        >
          <wa-button
            id="approve-split-trigger-button"
            slot="trigger"
            class="approve-split-trigger"
            appearance="plain"
            variant="neutral"
            size="small"
            type="button"
            aria-label="More approve options"
          >
            ${waIcon('chevron-down')}
          </wa-button>
          ${when(
            this.canBypass,
            () =>
              html`<wa-dropdown-item value=${YOLO_VALUE}>
                ${waIcon('shield')} Yolo (this session)
              </wa-dropdown-item>`,
          )}
          ${when(
            this.canApproveAllDelegatedWork,
            () =>
              html`<wa-dropdown-item value=${DELEGATED_WORK_VALUE}>
                ${waIcon('rocket')} ${DELEGATION_APPROVAL_COPY.streamMenuAction}
              </wa-dropdown-item>`,
          )}
        </wa-dropdown>
        <wa-tooltip for="approve-split-trigger-button">
          ${
            this.canApproveAllDelegatedWork
              ? `${DELEGATION_APPROVAL_COPY.streamMenuAction} (a)`
              : 'Approve and stop asking this session (a)'
          }
        </wa-tooltip>
      </div>
    `;
  }

  private handleSelect = (event: CustomEvent<{ item: HTMLElement }>): void => {
    const value =
      (event.detail?.item as HTMLElement & { value?: string })?.value ?? '';
    if (value === YOLO_VALUE) {
      this.emit('approve-session');
    } else if (value === DELEGATED_WORK_VALUE) {
      this.emit('approve-all-delegated-work');
    }
  };

  private emit(
    type: 'approve' | 'approve-session' | 'approve-all-delegated-work',
  ): void {
    // Dispatch via the shared typed factory (bubbles + composed) like every
    // other ProgressView component, not a hand-rolled CustomEvent.
    this.dispatchEvent(createEvent(type));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'approve-split-button': ApproveSplitButton;
  }
}
