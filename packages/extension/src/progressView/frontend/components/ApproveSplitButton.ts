/** Approve control with an optional "Yolo (this session)" split-menu. */

// Third-party imports
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles + helpers
import { commonViewStyles, designTokens } from '@shared/styles';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/** Internal dropdown-item value for the session-bypass entry. */
const YOLO_VALUE = 'approve-session';

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
 * When `canBypass` is false it renders a plain Approve button. When true it
 * becomes a split button: the main click emits `approve`; the ▾ caret opens a
 * menu whose "Yolo (this session)" item emits `approve-session`. Selection is
 * handled via Web Awesome's `wa-select` (Enter/Space dispatch `wa-select`, not a
 * DOM click on the item), so the menu stays keyboard-accessible. Layout/colors
 * are scoped here; outer width is governed by the host via the inherited
 * `--action-button-basis` so it matches the surrounding action row.
 */
@customElement('approve-split-button')
export class ApproveSplitButton extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: inline-flex;
        flex: 1 1 var(--action-button-basis, 8rem);
        min-width: 0;
        max-width: 100%;
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

  /** When true, surface the "Yolo (this session)" split menu. */
  @property({ type: Boolean }) canBypass = false;

  override render(): TemplateResult {
    const approveButton = renderLabeledActionButton({
      icon: 'check',
      text: 'Approve',
      title: this.approveTitle,
      action: 'approve',
      className: 'approve-split-main',
      onClick: () => this.emit('approve'),
    });
    if (!this.canBypass) {
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
            title="Approve and stop asking for edits & bash this session (a)"
          >
            ${waIcon('chevron-down')}
          </wa-button>
          <wa-dropdown-item value=${YOLO_VALUE}>
            ${waIcon('shield')} Yolo (this session)
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
    `;
  }

  private handleSelect = (event: CustomEvent<{ item: HTMLElement }>): void => {
    const value =
      (event.detail?.item as HTMLElement & { value?: string })?.value ?? '';
    // The menu has a single actionable item; ignore anything else defensively.
    if (value === YOLO_VALUE) {
      this.emit('approve-session');
    }
  };

  private emit(type: 'approve' | 'approve-session'): void {
    this.dispatchEvent(
      new CustomEvent(type, { bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'approve-split-button': ApproveSplitButton;
  }
}
