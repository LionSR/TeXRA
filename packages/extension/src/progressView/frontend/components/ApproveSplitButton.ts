/** Approve control with an optional "Yolo" / "Super Yolo" split-menu. */

// Third-party imports
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles + helpers
import { commonViewStyles, designTokens } from '@shared/styles';
import { createEvent } from '@shared/utils/events';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/** Internal dropdown-item value for the edit/bash session-bypass entry. */
const YOLO_VALUE = 'approve-session';
/** Internal dropdown-item value for the proposal super-yolo entry. */
const SUPER_YOLO_VALUE = 'approve-super-yolo';

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
 * (edit/bash prompts) or `canSuperYolo` (agent proposals) is set it becomes a
 * split button: the main click emits `approve`; the ▾ caret opens a menu whose
 * "Yolo (this session)" item emits `approve-session` and whose "Super Yolo (this
 * session)" item emits `approve-super-yolo`. Selection is handled via Web
 * Awesome's `wa-select` (Enter/Space dispatch `wa-select`, not a DOM click on
 * the item), so the menu stays keyboard-accessible. Layout/colors are scoped
 * here; the host is width-capped to match the `.action-button` rule in
 * `requestPanelStyles` (#6658) so Approve stays button-sized like its siblings.
 */
@customElement('approve-split-button')
export class ApproveSplitButton extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      /* Mirror the .action-button cap (requestPanelStyles, #6658): hug content
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

      .approve-split .approve-split-main::part(base) {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
      }

      .approve-split-menu {
        flex: 0 0 auto;
        display: inline-flex;
      }

      .approve-split-trigger {
        flex: 0 0 auto;
        width: 20px;
        min-width: 20px;
        padding: 0;
      }

      .approve-split-trigger::part(base) {
        padding: 0;
        color: var(--wa-color-success-fill-loud);
        border-top-left-radius: 0;
        border-bottom-left-radius: 0;
        border-left: var(--border-thin) solid
          var(--wa-color-button-separator, var(--wa-form-control-border-color));
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

  /** When true, surface the proposal "Super Yolo (this session)" menu item. */
  @property({ type: Boolean }) canSuperYolo = false;

  override render(): TemplateResult {
    const approveButton = renderLabeledActionButton({
      icon: 'check',
      text: 'Approve',
      title: this.approveTitle,
      action: 'approve',
      className: 'approve-split-main',
      onClick: () => this.emit('approve'),
    });
    if (!this.canBypass && !this.canSuperYolo) {
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
            slot="trigger"
            class="action-icon-button approve-split-trigger"
            appearance="plain"
            variant="neutral"
            size="small"
            type="button"
            aria-label="More approve options"
            title="Approve and stop asking this session (a)"
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
            this.canSuperYolo,
            () =>
              html`<wa-dropdown-item value=${SUPER_YOLO_VALUE}>
                ${waIcon('rocket')} Super Yolo (this session)
              </wa-dropdown-item>`,
          )}
        </wa-dropdown>
      </div>
    `;
  }

  private handleSelect = (
    event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
  ): void => {
    const value = event.detail?.item?.value ?? '';
    // Ignore unknown menu values defensively.
    if (value === YOLO_VALUE) {
      this.emit('approve-session');
    } else if (value === SUPER_YOLO_VALUE) {
      this.emit('approve-super-yolo');
    }
  };

  private emit(
    type: 'approve' | 'approve-session' | 'approve-super-yolo',
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
