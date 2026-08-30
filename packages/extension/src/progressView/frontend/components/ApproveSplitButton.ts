/** Approve control with optional run-scoped approval actions. */

// Third-party imports
import { css, html, LitElement, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components used by this template
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles + helpers
import { commonViewStyles, designTokens } from '@shared/styles';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';
import { createEvent } from '@shared/utils/events';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import {
  renderSplitButtonMenuParts,
  splitButtonTriggerStyles,
} from '@shared/wa/splitButton';
import { waIcon } from '@shared/wa/webAwesomeIcons';

/** Each menu item's dropdown-item value is the event it emits when selected. */
const MENU_EVENTS = ['approve-session', 'approve-all-delegated-work'] as const;
type MenuEvent = (typeof MENU_EVENTS)[number];

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
 * With no menu flags it renders a plain Approve button. When `canBypass`
 * (edit/bash prompts) or `canApproveAllDelegatedWork` (agent proposals) is
 * set it becomes a split button: the main click emits `approve`; the ▾ caret
 * opens a menu whose items emit the event named by their value —
 * `approve-session` (the `bypassAction` item) and
 * `approve-all-delegated-work`. Selection is handled via Web Awesome's `wa-select`
 * (Enter/Space dispatch `wa-select`, not a DOM click on the item), so the
 * menu stays keyboard-accessible.
 *
 * Web Awesome's native button group owns the split geometry. This component
 * retains only the action-row width cap and compact caret sizing.
 */
@customElement('approve-split-button')
export class ApproveSplitButton extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    splitButtonTriggerStyles,
    css`
      /* Mirror the .action-button cap (requestPanelSharedStyles, #6658): hug
         content so Approve stays button-sized instead of filling the row. */
      :host {
        display: inline-flex;
        flex: 0 1 auto;
        min-width: auto;
        max-width: min(14rem, 100%);
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
    const hasMenu =
      !this.disabled && (this.canBypass || this.canApproveAllDelegatedWork);
    const approveButton = renderLabeledActionButton({
      icon: 'check',
      text: 'Approve',
      title: this.approveTitle,
      action: 'approve',
      kind: hasMenu ? undefined : 'primary',
      nativeChrome: hasMenu,
      appearance: hasMenu ? 'accent' : undefined,
      variant: hasMenu ? 'brand' : undefined,
      className: 'approve-split-main',
      disabled: this.disabled,
      onClick: () => this.emit('approve'),
    });
    if (!hasMenu) return approveButton;

    const { menu, tooltip } = renderSplitButtonMenuParts({
      classPrefix: 'approve-split',
      triggerId: 'approve-split-trigger-button',
      triggerAriaLabel: 'More approve options',
      triggerAppearance: 'accent',
      triggerVariant: 'brand',
      tooltip: this.canApproveAllDelegatedWork
        ? `${DELEGATION_APPROVAL_COPY.progressViewExplanation} (a)`
        : `${this.bypassAction} (a)`,
      items: html`
        ${when(
          this.canBypass,
          () =>
            html`<wa-dropdown-item value="approve-session">
              ${waIcon('shield')} ${this.bypassAction}
            </wa-dropdown-item>`,
        )}
        ${when(
          this.canApproveAllDelegatedWork,
          () =>
            html`<wa-dropdown-item value="approve-all-delegated-work">
              ${waIcon('rocket')} ${DELEGATION_APPROVAL_COPY.progressViewAction}
            </wa-dropdown-item>`,
        )}
      `,
      onSelect: this.handleSelect,
    });

    return html`
      <wa-button-group class="approve-split split-group" label="Approve">
        ${approveButton} ${menu}
      </wa-button-group>
      ${tooltip}
    `;
  }

  private handleSelect = (value: string): void => {
    const event = MENU_EVENTS.find((name) => name === value);
    if (event) this.emit(event);
  };

  private emit(type: 'approve' | MenuEvent): void {
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
