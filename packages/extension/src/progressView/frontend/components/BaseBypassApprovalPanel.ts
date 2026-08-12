/** Approval panel capability for edit and bash session bypass. */

// Local imports - shared copy
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

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

/** Per-kind grant wording: the menu item names only the kind it enables. */
function bypassActionLabel({ kind }: BypassPermission): string {
  return kind === 'toolEdit'
    ? DELEGATION_APPROVAL_COPY.progressViewEditAction
    : DELEGATION_APPROVAL_COPY.progressViewCommandAction;
}

export abstract class BaseBypassApprovalPanel<
  K extends BypassPermissionKind,
> extends BaseApprovalPanel<K> {
  private readonly sessionApprovalDecision = {
    action: APPROVE_SESSION_ACTION,
  } as const;

  protected override get canBypass(): boolean {
    return canBypassSession(this.permission);
  }

  protected override get bypassAction(): string {
    return bypassActionLabel(this.permission);
  }

  protected override approveSessionHandler(): void {
    this.emitAction(this.sessionApprovalDecision);
  }
}
