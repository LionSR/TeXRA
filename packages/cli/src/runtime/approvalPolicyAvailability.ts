import type { CliApprovalPolicy } from '../schemas/cliSettings';

export type ApprovalInstructionContext = {
  readonly approvalPolicy: CliApprovalPolicy;
  readonly mode: 'headless' | 'interactive';
};

export type TeamDelegationPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly recovery: string;
    };

export function approvalPromptsUnavailable(
  context: ApprovalInstructionContext,
): boolean {
  return (
    context.approvalPolicy === 'never' ||
    (context.mode === 'headless' && context.approvalPolicy === 'ask')
  );
}

/**
 * Decide whether a team root can reach its members under the active CLI
 * approval policy. Team launches must use this before entering the model
 * picker or execution path; otherwise the runtime hides delegation and leaves
 * an orchestrator that cannot use its team.
 */
export function evaluateTeamDelegationPolicy(
  context: ApprovalInstructionContext,
): TeamDelegationPolicyDecision {
  if (!approvalPromptsUnavailable(context)) return { allowed: true };

  if (context.approvalPolicy === 'never') {
    return {
      allowed: false,
      reason: 'approval policy "never" denies subagent delegation',
      recovery:
        'Restart with `texra orchestrate --approval-policy ask` to approve delegation when requested, or use `--approval-policy yolo` only when you intend to auto-approve privileged actions.',
    };
  }

  return {
    allowed: false,
    reason:
      'a headless run cannot answer delegation prompts under approval policy "ask"',
    recovery:
      'Run `texra orchestrate --approval-policy ask` to answer delegation prompts, or use `--approval-policy yolo` only when you intend to auto-approve privileged actions.',
  };
}

export function formatTeamDelegationPolicyBlock(
  team: string,
  decision: Exclude<TeamDelegationPolicyDecision, { readonly allowed: true }>,
): string {
  return `Team "${team}" cannot start: ${decision.reason}. ${decision.recovery}`;
}
