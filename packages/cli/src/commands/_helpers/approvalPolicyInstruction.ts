export type ApprovalInstructionContext = {
  readonly approvalPolicy: 'ask' | 'never' | 'yolo';
  readonly mode: 'headless' | 'interactive';
};

const PRIVILEGED_ACTION_GUIDANCE =
  'Do not call approval-gated tools such as bash/shell commands, file edits, retry/plan approvals, or new subagent delegations; solve from the provided context or state what approval is needed.';

export function approvalPromptsUnavailable(
  context: ApprovalInstructionContext,
): boolean {
  return (
    context.approvalPolicy === 'never' ||
    (context.mode === 'headless' && context.approvalPolicy === 'ask')
  );
}

export function formatUnavailableApprovalInstruction(
  context: ApprovalInstructionContext,
): string | undefined {
  if (context.approvalPolicy === 'never') {
    return [
      'Approval policy for this run is "never": privileged actions that require approval will be rejected automatically.',
      PRIVILEGED_ACTION_GUIDANCE,
    ].join(' ');
  }

  if (context.mode === 'headless' && context.approvalPolicy === 'ask') {
    return [
      'This is a headless run with approval policy "ask": approval prompts cannot be answered, so privileged actions that require approval will be rejected automatically.',
      PRIVILEGED_ACTION_GUIDANCE,
    ].join(' ');
  }

  return undefined;
}
