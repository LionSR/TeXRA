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
import { assertNever } from '@utils/core';

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
 * Each permission kind's wire schema names its id field differently
 * (`requestId` / `streamId` / `proposalId` / `approvalId`). Switching on
 * `kind` here narrows `data` to the matching variant, so callers get the id
 * without a `Record<string, unknown>` cast into an untyped field name.
 */
export function permissionId(permission: PermissionState): string {
  switch (permission.kind) {
    case PERMISSION_KIND.RETRY:
      return permission.data.streamId;
    case PERMISSION_KIND.PLAN_APPROVAL:
      return permission.data.approvalId;
    case PERMISSION_KIND.PROPOSAL:
      return permission.data.proposalId;
    case PERMISSION_KIND.TOOL_EDIT:
    case PERMISSION_KIND.BASH:
    case PERMISSION_KIND.EXTERNAL_INQUIRY:
    case PERMISSION_KIND.USER_QUESTION:
      return permission.data.requestId;
    default:
      return assertNever(permission, 'Unhandled PermissionState kind');
  }
}

/** Stable identity key for a pending permission, used for selection/dedup. */
export function getPermissionKey(permission: PermissionState): string {
  return `${permission.kind}:${permissionId(permission)}`;
}
