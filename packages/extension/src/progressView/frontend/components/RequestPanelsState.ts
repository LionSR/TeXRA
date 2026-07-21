// Local imports - shared utilities
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { clampIndex } from '@utils/core';

// Local imports - progress view component types
import { permissionId, type PermissionState } from '../permissionState';
import type { BaseRequestPanel } from './BaseRequestPanel';

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

const KIND_TO_GROUP: Record<PermissionState['kind'], keyof PermissionGroups> = {
  [PERMISSION_KIND.TOOL_EDIT]: 'approval',
  [PERMISSION_KIND.BASH]: 'bash',
  [PERMISSION_KIND.RETRY]: 'retry',
  [PERMISSION_KIND.PROPOSAL]: 'proposal',
  [PERMISSION_KIND.PLAN_APPROVAL]: 'planApproval',
  [PERMISSION_KIND.EXTERNAL_INQUIRY]: 'externalInquiry',
  [PERMISSION_KIND.USER_QUESTION]: 'userQuestion',
};

export function groupPermissions(
  permissions: PermissionState[],
): PermissionGroups {
  const groups = createEmptyPermissionGroups();
  for (const permission of permissions) {
    // Guard against malformed IPC data: an unknown kind is dropped (matching
    // the old switch's no-default behavior) rather than throwing in render.
    const group = KIND_TO_GROUP[permission.kind];
    if (group) groups[group].push(permission);
  }
  return groups;
}

/** Keep a selected inquiry by key, choosing its nearest successor if removed. */
export function selectExternalInquiryKey(
  selectedKey: string | null,
  previousKeys: readonly string[],
  keys: readonly string[],
): string | null {
  if (keys.length === 0) return null;
  if (selectedKey && keys.includes(selectedKey)) return selectedKey;

  const previousIndex = selectedKey ? previousKeys.indexOf(selectedKey) : 0;
  const fallbackIndex = clampIndex(previousIndex, keys.length);
  return keys[fallbackIndex] ?? null;
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
  return `${permission.kind}:${permissionId(permission)}`;
}
