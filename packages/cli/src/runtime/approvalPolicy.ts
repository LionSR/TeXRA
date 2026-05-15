export const CLI_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export type CliApprovalPolicy = (typeof CLI_APPROVAL_POLICIES)[number];

export function parseCliApprovalPolicy(
  value: string | undefined,
): CliApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  return (CLI_APPROVAL_POLICIES as readonly string[]).includes(value)
    ? (value as CliApprovalPolicy)
    : undefined;
}
