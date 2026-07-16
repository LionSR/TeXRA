/** Approval panel capability for edit and bash session bypass. */

// Third-party imports
import { html, type TemplateResult } from 'lit';

// Local imports - base class
import { BaseApprovalPanel } from './BaseApprovalPanel';

// Local imports - progress view events
import { APPROVE_SESSION_ACTION } from '../events';

// Local imports - progress view state
import type { PermissionState } from '../permissionState';

type BypassPermissionKind = 'toolEdit' | 'bash';
type BypassPermission = Extract<
  PermissionState,
  { kind: BypassPermissionKind }
>;

// `this.permission` is `Extract<PermissionState, { kind: K }>` for the
// generic `K`; TS cannot distribute that conditional type over the
// `PermissionState` union while `K` is unresolved, so direct property access
// on `this.permission` fails to typecheck. Passing it through this
// concretely-typed helper (bound to the literal `BypassPermissionKind`, not
// the generic `K`) gives the compiler a resolvable type to check against.
function canBypassSession({ data }: BypassPermission): boolean {
  return Boolean(data.allowBypass && data.streamId);
}

export abstract class BaseBypassApprovalPanel<
  K extends BypassPermissionKind,
> extends BaseApprovalPanel<K> {
  private readonly sessionApprovalDecision = {
    action: APPROVE_SESSION_ACTION,
  } as const;

  private get canBypass(): boolean {
    return canBypassSession(this.permission);
  }

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
