import {
  approvalPromptsUnavailable,
  type ApprovalInstructionContext,
} from '@cli/runtime/approvalPolicyAvailability';

export { approvalPromptsUnavailable, type ApprovalInstructionContext };

const PRIVILEGED_ACTION_GUIDANCE =
  'Do not call approval-gated tools such as bash/shell commands, file edits, setup/config updates, user questions, retry/plan approvals, or new subagent delegations; solve from the provided context or state what approval is needed.';
const CLI_APPROVAL_POLICY_GUIDANCE =
  'Valid CLI approval policies are "ask", "never", and "yolo" only. If suggesting a rerun, use --approval-policy yolo for headless auto-approval or an interactive run with --approval-policy ask; do not invent other approval mode names.';

export function formatUnavailableApprovalInstruction(
  context: ApprovalInstructionContext,
): string | undefined {
  if (context.approvalPolicy === 'never') {
    return [
      'Approval policy for this run is "never": privileged actions that require approval will be rejected automatically.',
      PRIVILEGED_ACTION_GUIDANCE,
      CLI_APPROVAL_POLICY_GUIDANCE,
    ].join(' ');
  }

  if (context.mode === 'headless' && context.approvalPolicy === 'ask') {
    return [
      'This is a headless run with approval policy "ask": approval prompts cannot be answered, so privileged actions that require approval will be rejected automatically.',
      PRIVILEGED_ACTION_GUIDANCE,
      CLI_APPROVAL_POLICY_GUIDANCE,
    ].join(' ');
  }

  return undefined;
}
