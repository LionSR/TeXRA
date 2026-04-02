// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view component types
import type { BaseRequestPanel } from './BaseRequestPanel';
import type { PermissionState } from './PermissionCard';

export const REQUEST_PANEL_SELECTOR =
  'tool-edit-request-panel, bash-request-panel, retry-request-panel, proposal-request-panel, plan-approval-request-panel, external-inquiry-panel';

export interface PermissionGroups {
  approval: PermissionState[];
  bash: PermissionState[];
  retry: PermissionState[];
  proposal: PermissionState[];
  planApproval: PermissionState[];
  externalInquiry: PermissionState[];
}

export function createEmptyPermissionGroups(): PermissionGroups {
  return {
    approval: [],
    bash: [],
    retry: [],
    proposal: [],
    planApproval: [],
    externalInquiry: [],
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
    }
  }

  return groups;
}

export function clampExternalInquiryIndex(
  index: number,
  permissions: PermissionState[],
): number {
  if (permissions.length === 0) return 0;
  return Math.min(index, permissions.length - 1);
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
