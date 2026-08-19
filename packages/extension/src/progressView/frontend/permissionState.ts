/**
 * Permission prompt state — the discriminated union of every pending
 * permission/approval kind the progress view can display.
 *
 * Lives in its own leaf module (not `components/PermissionCard.ts`) so state
 * files (store, contexts, slices, dispatcher) can type against it without
 * importing the Lit component and its side-effect imports.
 */
import type {
  AgentOptionData,
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  ModelOptionData,
  PlanApprovalPermission,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

export type PermissionState =
  | { kind: typeof PERMISSION_KIND.TOOL_EDIT; data: ToolEditPermission }
  | { kind: typeof PERMISSION_KIND.BASH; data: BashPermission }
  | { kind: typeof PERMISSION_KIND.RETRY; data: RetryPermission }
  | {
      kind: typeof PERMISSION_KIND.PROPOSAL;
      data: AgentProposalPermission;
      modelOptions?: ModelOptionData[];
      agentOptions?: AgentOptionData[];
    }
  | {
      kind: typeof PERMISSION_KIND.PLAN_APPROVAL;
      data: PlanApprovalPermission;
    }
  | {
      kind: typeof PERMISSION_KIND.EXTERNAL_INQUIRY;
      data: ExternalInquiryPermission;
    }
  | {
      kind: typeof PERMISSION_KIND.USER_QUESTION;
      data: UserQuestionPermission;
    };

/**
 * Every permission kind's wire schema carries `requestId`; retry is the one
 * kind not *keyed* by it — retry is keyed by `streamId` instead (one pending
 * retry per stream, a new request replaces the old one).
 */
export function permissionId(permission: PermissionState): string {
  return permission.kind === PERMISSION_KIND.RETRY
    ? permission.data.streamId
    : permission.data.requestId;
}

/** Stable identity key for a pending permission, used for selection/dedup. */
export function getPermissionKey(permission: PermissionState): string {
  return `${permission.kind}:${permissionId(permission)}`;
}
