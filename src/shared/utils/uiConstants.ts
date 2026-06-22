export const PERMISSION_KIND = {
  TOOL_EDIT: 'toolEdit',
  BASH: 'bash',
  RETRY: 'retry',
  PROPOSAL: 'proposal',
  PLAN_APPROVAL: 'planApproval',
  EXTERNAL_INQUIRY: 'externalInquiry',
  USER_QUESTION: 'userQuestion',
} as const;

export type PermissionKind =
  (typeof PERMISSION_KIND)[keyof typeof PERMISSION_KIND];

/** Permission kinds that support rejection feedback */
export const FEEDBACK_ELIGIBLE_KINDS = new Set<PermissionKind>([
  PERMISSION_KIND.TOOL_EDIT,
  PERMISSION_KIND.BASH,
  PERMISSION_KIND.PROPOSAL,
  PERMISSION_KIND.PLAN_APPROVAL,
  PERMISSION_KIND.EXTERNAL_INQUIRY,
  PERMISSION_KIND.USER_QUESTION,
]);
