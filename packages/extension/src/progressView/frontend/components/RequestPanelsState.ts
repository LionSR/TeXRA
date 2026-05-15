// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view component types
import type { BaseRequestPanel } from './BaseRequestPanel';
import type { PermissionState } from './PermissionCard';

const REQUEST_PANEL_SELECTOR =
  'tool-edit-request-panel, bash-request-panel, retry-request-panel, proposal-request-panel, plan-approval-request-panel, external-inquiry-panel, user-question-panel';

export interface PermissionGroups {
  approval: PermissionState[];
  bash: PermissionState[];
  retry: PermissionState[];
  proposal: PermissionState[];
  planApproval: PermissionState[];
  externalInquiry: PermissionState[];
  userQuestion: PermissionState[];
}

export function createEmptyPermissionGroups(): PermissionGroups {
  return {
    approval: [],
    bash: [],
    retry: [],
    proposal: [],
    planApproval: [],
    externalInquiry: [],
    userQuestion: [],
  };
}

export function groupPermissions(
  permissions: PermissionState[],
): PermissionGroups {
  const groups = createEmptyPermissionGroups();

  for (const permission of permissions) {
    switch (permission.kind) {
      case PERMISSION_KIND.TOOL_EDIT:
        groups.approval.push(permission);
        break;
      case PERMISSION_KIND.BASH:
        groups.bash.push(permission);
        break;
      case PERMISSION_KIND.RETRY:
        groups.retry.push(permission);
        break;
      case PERMISSION_KIND.PROPOSAL:
        groups.proposal.push(permission);
        break;
      case PERMISSION_KIND.PLAN_APPROVAL:
        groups.planApproval.push(permission);
        break;
      case PERMISSION_KIND.EXTERNAL_INQUIRY:
        groups.externalInquiry.push(permission);
        break;
      case PERMISSION_KIND.USER_QUESTION:
        groups.userQuestion.push(permission);
        break;
    }
  }

  return groups;
}

/**
 * Resolve the external inquiry carousel index after the permissions list
 * changes. When a tracked permission key is provided, try to find it in
 * the updated list so the carousel stays on the same inquiry even when
 * earlier entries are resolved. Falls back to clamping when the tracked
 * entry is no longer present.
 */
export function resolveExternalInquiryIndex(
  prevIndex: number,
  permissions: PermissionState[],
  trackedKey: string | null,
): number {
  if (permissions.length === 0) return 0;
  if (trackedKey) {
    const found = permissions.findIndex(
      (p) => getPermissionKey(p) === trackedKey,
    );
    if (found >= 0) return found;
  }
  return Math.min(prevIndex, permissions.length - 1);
}

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return true;
  }
  if ((el as HTMLElement).isContentEditable) return true;

  const tagName = el.tagName?.toLowerCase() ?? '';
  if (tagName.includes('textarea') || tagName.includes('input')) return true;

  return isTextInput(el.shadowRoot?.activeElement ?? null);
}

export function getActivePermission(params: {
  permissions: PermissionState[];
  externalInquiryPermissions: PermissionState[];
  externalInquiryIndex: number;
}): PermissionState | null {
  const newest = params.permissions[0];
  if (!newest) return null;

  if (
    newest.kind === PERMISSION_KIND.EXTERNAL_INQUIRY &&
    params.externalInquiryPermissions.length > 1
  ) {
    return (
      params.externalInquiryPermissions[params.externalInquiryIndex] ?? null
    );
  }

  return newest;
}

export function isActiveExternalInquiryCarousel(params: {
  permissions: PermissionState[];
  externalInquiryPermissions: PermissionState[];
}): boolean {
  return (
    params.permissions[0]?.kind === PERMISSION_KIND.EXTERNAL_INQUIRY &&
    params.externalInquiryPermissions.length > 1
  );
}

export function findPanelForPermission(
  renderRoot: ParentNode,
  permission: PermissionState | null,
): BaseRequestPanel | null {
  if (!permission) return null;

  const panels = renderRoot.querySelectorAll<BaseRequestPanel>(
    REQUEST_PANEL_SELECTOR,
  );
  for (const panel of panels) {
    if (panel.permission === permission) return panel;
  }
  return null;
}

export function getPermissionKey(permission: PermissionState): string {
  let id: string;
  switch (permission.kind) {
    case PERMISSION_KIND.RETRY:
      id = permission.data.streamId;
      break;
    case PERMISSION_KIND.PROPOSAL:
      id = permission.data.proposalId;
      break;
    case PERMISSION_KIND.PLAN_APPROVAL:
      id = permission.data.approvalId;
      break;
    default:
      id = permission.data.requestId;
      break;
  }

  return `${permission.kind}:${id}`;
}
