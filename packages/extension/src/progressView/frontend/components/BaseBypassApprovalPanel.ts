/** Approval panel capability for edit and bash session bypass. */

// Third-party imports
import { html, type TemplateResult } from 'lit';

// Local imports - progress view events
import { APPROVE_SESSION_ACTION } from '../events';

// Local imports - base class
import { BaseApprovalPanel } from './BaseApprovalPanel';

type BypassPermissionKind = 'toolEdit' | 'bash';

export abstract class BaseBypassApprovalPanel<
  K extends BypassPermissionKind,
> extends BaseApprovalPanel<K> {
  protected abstract readonly canBypass: boolean;

  private readonly sessionApprovalDecision = {
    action: APPROVE_SESSION_ACTION,
  } as const;

  override handleKeyboardShortcut(key: string): boolean {
    if (key !== 'a') return super.handleKeyboardShortcut(key);
    if (this.archived || this.showFeedback || !this.canBypass) return false;
    this.emitAction(this.sessionApprovalDecision);
    return true;
  }

  protected override renderApproveButton(approveTitle: string): TemplateResult {
    return html`
      <approve-split-button
        .approveTitle=${approveTitle}
        .canBypass=${this.canBypass}
        .disabled=${this.archived}
        @approve=${() => this.emitAction(this.approvalDecision)}
        @approve-session=${() => this.emitAction(this.sessionApprovalDecision)}
      ></approve-split-button>
    `;
  }
}
