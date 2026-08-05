/**
 * Extension status-bar tooltip refresh for the live TeXRA approval policy.
 *
 * `setApprovalPolicy` mutates the session with no notification; composition
 * registers the tooltip painter once, and seed/re-seed sites call refresh.
 */

let refresh: (() => void) | undefined;

export function setApprovalPolicyTooltipRefresh(
  fn: (() => void) | undefined,
): void {
  refresh = fn;
}

export function refreshApprovalPolicyTooltip(): void {
  refresh?.();
}
