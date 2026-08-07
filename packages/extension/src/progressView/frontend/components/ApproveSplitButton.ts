/** Approve control with optional run-scoped approval actions. */

// Third-party imports
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components used by this template
// (the split-button caret/menu registrations come from @shared/wa/splitButton)
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles + helpers
import { commonViewStyles, designTokens } from '@shared/styles';
import { splitButtonStyles } from '@shared/styles/controlStyles';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';
import { createEvent } from '@shared/utils/events';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSplitButtonMenu } from '@shared/wa/splitButton';
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
 *     .bypassAction=${bypassAction}
 *     @approve=${onApprove}
 *     @approve-session=${onYolo}
 *   ></approve-split-button>
 *
 * With no bypass flags it renders a plain Approve button. When `canBypass`
 * (edit/bash prompts) or `canApproveAllDelegatedWork` (agent proposals) is set
 * it becomes a
 * split button: the main click emits `approve`; the ▾ caret opens a menu whose
 * `bypassAction` item emits `approve-session` and whose delegated-work item
 * emits `approve-all-delegated-work`. Selection is handled via Web
 * Awesome's `wa-select` (Enter/Space dispatch `wa-select`, not a DOM click on
 * the item), so the menu stays keyboard-accessible.
 *
 * The fused-pill layout comes from the shared `splitButtonStyles`; this
 * component contributes only its primary skin (`--split-fill`/`--split-accent`)
 * and the host width cap that matches the `.action-button` rule in
 * `requestPanelSharedStyles` (#6658), so Approve stays button-sized like its
 * siblings. The `.approve-split*` class names are kept alongside the shared
 * ones because the component's tests query them.
 */
@customElement('approve-split-button')
export class ApproveSplitButton extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    splitButtonStyles,
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
        /* Approve is the panel's one primary action, so it takes the shared
           .btn-primary fill (see the primary kind passed in render). These
           carry that skin across the caret half, which the split skin would
           otherwise leave transparent beside a filled label.

           Both are brand tokens because .btn-primary is the accent fill and
           the design system allows one per view — a second, green fill would
           be a competing accent. Tinting the label green instead is what made
           Approve read as plain text: it is a transparent button whose only
           weight is its label colour. */
        --split-fill: var(--wa-color-brand-fill-loud);
        --split-accent: var(--wa-color-brand-on-loud);
      }
    `,
  ];

  /** Tooltip / aria-label for the main Approve button. */
  @property({ attribute: false }) approveTitle = '';

  /** When true, surface the edit/bash run-approval menu item. */
  @property({ type: Boolean }) canBypass = false;

  /**
   * Label for that menu item. The grant is per-kind, so the prompt panel
   * supplies wording naming only the kind it will auto-approve.
   */
  @property({ attribute: false }) bypassAction = '';

  /** When true, surface the proposal's run-scoped approve-all action. */
  @property({ type: Boolean }) canApproveAllDelegatedWork = false;

  /** Read-only trace-viewer export: render inert, no bypass split-menu. */
  @property({ type: Boolean }) disabled = false;

  override render(): TemplateResult {
    const approveButton = renderLabeledActionButton({
      icon: 'check',
      text: 'Approve',
      title: this.approveTitle,
      action: 'approve',
      kind: 'primary',
      className: 'approve-split-main split-button-main',
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
      <div class="approve-split split-button">
        ${approveButton}
        ${renderSplitButtonMenu({
          classPrefix: 'approve-split',
          triggerId: 'approve-split-trigger-button',
          triggerAriaLabel: 'More approve options',
          tooltip: this.canApproveAllDelegatedWork
            ? `${DELEGATION_APPROVAL_COPY.progressViewExplanation} (a)`
            : `${this.bypassAction} (a)`,
          items: html`
            ${when(
              this.canBypass,
              () =>
                html`<wa-dropdown-item value=${YOLO_VALUE}>
                  ${waIcon('shield')} ${this.bypassAction}
                </wa-dropdown-item>`,
            )}
            ${when(
              this.canApproveAllDelegatedWork,
              () =>
                html`<wa-dropdown-item value=${DELEGATED_WORK_VALUE}>
                  ${waIcon('rocket')}
                  ${DELEGATION_APPROVAL_COPY.progressViewAction}
                </wa-dropdown-item>`,
            )}
          `,
          onSelect: this.handleSelect,
        })}
      </div>
    `;
  }

  private handleSelect = (value: string): void => {
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
