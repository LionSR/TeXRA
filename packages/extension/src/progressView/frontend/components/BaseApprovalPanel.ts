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

  // -------------------------------------------------------------------------
  // Run-scoped approve-menu affordances. The ApproveSplitButton accepts them
  // as independent props; these overridable members let subclasses configure
  // them instead of re-templating the markup (see BaseBypassApprovalPanel,
  // ProposalRequestPanel). All default to the plain-approve configuration.
  // -------------------------------------------------------------------------

  /** Edit/bash session-bypass affordance. Override to enable the menu item. */
  protected get canBypass(): boolean {
    return false;
  }

  /** Label for the session-bypass menu item; only read when canBypass. */
  protected get bypassAction(): string {
    return '';
  }

  /** Proposal run-scoped approve-all affordance. Override to enable it. */
  protected get canApproveAllDelegatedWork(): boolean {
    return false;
  }

  /** Emit the edit/bash session-bypass decision; a no-op unless overridden. */
  protected approveSessionHandler(): void {}

  /** Emit the proposal approve-all decision; a no-op unless overridden. */
  protected approveAllDelegatedWorkHandler(): void {}

  override handleKeyboardShortcut(key: string): boolean {
    if (key === 'y') {
      if (this.archived) return false;
      this.emitAction(this.approvalDecision);
      return true;
    }
    // `a` accelerates whichever run-scoped action this panel's Approve menu
    // surfaces: the edit/bash session bypass or the proposal's approve-all.
    if (key === 'a') {
      if (this.archived || this.showFeedback) return false;
      if (this.canBypass) {
        this.approveSessionHandler();
        return true;
      }
      if (this.canApproveAllDelegatedWork) {
        this.approveAllDelegatedWorkHandler();
        return true;
      }
      return false;
    }
    return super.handleKeyboardShortcut(key);
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

  /**
   * The approve-split contract lives here: the full button template plus the
   * wiring of every run-scoped menu item. Subclasses configure which items
   * surface via the overridable members above; none re-template this markup.
   */
  protected renderApproveButton(approveTitle: string): TemplateResult {
    return html`
      <approve-split-button
        .approveTitle=${approveTitle}
        .canBypass=${this.canBypass}
        .bypassAction=${this.bypassAction}
        .canApproveAllDelegatedWork=${this.canApproveAllDelegatedWork}
        .disabled=${this.archived}
        @approve=${() => this.emitAction(this.approvalDecision)}
        @approve-session=${() => this.approveSessionHandler()}
        @approve-all-delegated-work=${() =>
          this.approveAllDelegatedWorkHandler()}
      ></approve-split-button>
    `;
  }
}
