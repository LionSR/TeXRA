import type { CliApprovalPolicy } from '../schemas/cliSettings';

export type ApprovalInstructionContext = {
  readonly approvalPolicy: CliApprovalPolicy;
  readonly mode: 'headless' | 'interactive';
};

export function approvalPromptsUnavailable(
  context: ApprovalInstructionContext,
): boolean {
  return (
    context.approvalPolicy === 'never' ||
    (context.mode === 'headless' && context.approvalPolicy === 'ask')
  );
}
