/** Shared shell and primary action for approval-capable request panels. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register the approve-split component
import './ApproveSplitButton';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

// Local imports - progress view events
import type { ApprovalDecision, ApprovalPermissionKind } from '../events';

export abstract class BaseApprovalPanel<
  K extends ApprovalPermissionKind,
> extends BaseFeedbackPanel<K> {
  /** The panel declares its approval; the base owns dispatch and shortcuts. */
  protected abstract readonly approvalDecision: ApprovalDecision<K>;

  override handleKeyboardShortcut(key: string): boolean {
    if (key !== 'y') return super.handleKeyboardShortcut(key);
    if (this.archived) return false;
    this.emitAction(this.approvalDecision);
    return true;
  }

  /**
   * Standard approve/reject panel shell. The class structure is the contract
   * consumed by requestPanelSharedStyles.
   */
  protected renderRequestShell(options: {
    prefix: string;
    details: TemplateResult;
    approveTitle: string;
    rejectTitle: string;
    leadingActions?: TemplateResult | typeof nothing;
    middleActions?: TemplateResult | typeof nothing;
    trailingActions?: TemplateResult | typeof nothing;
    feedbackPlaceholder?: string;
    trailing?: TemplateResult | typeof nothing;
  }): TemplateResult {
    const { prefix } = options;
    return html`
      <div
        class=${classMap({
          [prefix]: true,
          [`${prefix}--feedback-active`]: this.showFeedback,
        })}
      >
        <div class="${prefix}__details">${options.details}</div>
        <div class="${prefix}__actions">
          ${options.leadingActions ?? nothing}
          ${this.renderApproveButton(options.approveTitle)}
          ${options.middleActions ?? nothing}
          ${this.renderRejectButton(options.rejectTitle)}
          ${options.trailingActions ?? nothing}
        </div>
        ${this.renderFeedbackSection(
          `${prefix}__feedback`,
          `${prefix}__feedback-input`,
          options.feedbackPlaceholder,
        )}
        ${options.trailing ?? nothing}
      </div>
    `;
  }

  protected renderApproveButton(approveTitle: string): TemplateResult {
    return html`
      <approve-split-button
        .approveTitle=${approveTitle}
        .canBypass=${false}
        .disabled=${this.archived}
        @approve=${() => this.emitAction(this.approvalDecision)}
      ></approve-split-button>
    `;
  }
}
