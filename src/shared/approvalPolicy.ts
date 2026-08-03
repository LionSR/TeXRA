import { z } from 'zod';

export const TEXRA_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export const TexraApprovalPolicySchema = z.enum(TEXRA_APPROVAL_POLICIES);
export type TexraApprovalPolicy = z.infer<typeof TexraApprovalPolicySchema>;

const TEXRA_APPROVAL_POLICY_COPY = {
  ask: {
    label: 'Ask',
    description: 'Control Bash and edit prompts independently.',
  },
  never: {
    label: 'Never',
    description: 'Deny Bash commands and tool edits.',
  },
  yolo: {
    label: 'Auto-approve',
    description: 'Allow Bash commands and tool edits without approval.',
  },
} as const satisfies Record<
  TexraApprovalPolicy,
  {
    label: string;
    description: string;
  }
>;

const TEXRA_APPROVAL_POLICY_DISPLAY_ORDER = ['ask', 'never', 'yolo'] as const;

export const TEXRA_APPROVAL_POLICY_OPTIONS =
  TEXRA_APPROVAL_POLICY_DISPLAY_ORDER.map((value) => ({
    value,
    ...TEXRA_APPROVAL_POLICY_COPY[value],
  }));

export function formatTexraApprovalPolicy(policy: TexraApprovalPolicy): string {
  return TEXRA_APPROVAL_POLICY_COPY[policy].description;
}

export function parseTexraApprovalPolicy(
  input: string,
): TexraApprovalPolicy | undefined {
  const parsed = TexraApprovalPolicySchema.safeParse(
    input.trim().toLowerCase(),
  );
  return parsed.success ? parsed.data : undefined;
}

export type TexraApprovalPolicyDecision = 'allow' | 'deny' | 'present';

/** Decide one Bash or tool-edit permission from request-time policy facts. */
export function decideTexraApproval(input: {
  readonly policy: TexraApprovalPolicy;
  readonly promptRequired: boolean;
  readonly scopedBypass: boolean;
  readonly canPresent: boolean;
}): TexraApprovalPolicyDecision {
  if (input.policy === 'never') return 'deny';
  if (input.policy === 'yolo' || input.scopedBypass || !input.promptRequired) {
    return 'allow';
  }
  return input.canPresent ? 'present' : 'deny';
}
