export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];
