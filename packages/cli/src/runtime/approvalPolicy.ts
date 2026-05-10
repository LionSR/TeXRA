export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];

export function parseCliApprovalPolicy(
  value: string | undefined,
): CliApprovalPolicy {
  if (value === 'ask' || value === 'yolo') return value;
  return 'never';
}
