import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';

import type { ApprovalDecision } from './approvalPolicy';

const cliAgentProposalController = new ProgressAgentProposalController({
  // The CLI currently exposes approve/reject only. Keeping the setup hooks
  // explicit lets future setup support live behind the same controller.
  getPendingProposal: () => undefined,
  restoreTaskState: async () => false,
  resolveProposal: (proposalId, result) => {
    runCoordinatorBridge.resolveProposal(proposalId, result);
  },
});

export function handleCliAgentProposalDecision(
  proposalId: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  return cliAgentProposalController.handleAction(
    decision.accepted
      ? { proposalId, action: 'approve' }
      : {
          proposalId,
          action: 'reject',
          feedback: decision.userMessage,
        },
  );
}
