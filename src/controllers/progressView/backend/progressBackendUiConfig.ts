import {
  type BashSettlement,
  matchesCancelSelector,
  type HostInteractionCancelSelector,
  type UserQuestionSettlement,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type SettledInteractionKind,
} from '@agent/runtime/HostInteractions';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';

import type { ApprovalRequestHandler } from './ApprovalRequestHandler';

/**
 * The seven pending-approval handlers a host's progress interactions hold
 * (`progressHostInteractions.ts`): the toolEdit diff, the retry preparation,
 * and the inquiry residue a host still performs beside the fold's
 * `approval.requested` rows and the `decision.*` arms that settle them.
 */
export interface ApprovalRequestHandlerSet {
  toolEdit: ApprovalRequestHandler<ToolEditPermission, 'requestId'>;
  bash: ApprovalRequestHandler<BashPermission, 'requestId', BashSettlement>;
  retry: ApprovalRequestHandler<RetryPermission, 'streamId', RetryResult>;
  proposal: ApprovalRequestHandler<
    AgentProposalPermission,
    'requestId',
    ProposalResult
  >;
  planApproval: ApprovalRequestHandler<
    PlanApprovalPermission,
    'requestId',
    PlanApprovalResult
  >;
  externalInquiry: ApprovalRequestHandler<
    ExternalInquiryPermission,
    'requestId'
  >;
  userQuestion: ApprovalRequestHandler<
    UserQuestionPermission,
    'requestId',
    UserQuestionSettlement
  >;
}

/** Everything the cancellation sweep needs from one handler, so the set can be
 *  indexed by interaction kind without narrowing to a concrete payload type. */
interface CancellableApprovalRequestHandler {
  cancelWhere(
    predicate: (item: { readonly streamId: string }) => boolean,
    cause?: string,
  ): number;
}

/** Cancel the response-bearing progress interactions supported by one host. */
export function cancelApprovalRequestHandlers(
  handlers: ApprovalRequestHandlerSet,
  kinds: readonly SettledInteractionKind[],
  selector: HostInteractionCancelSelector,
): number {
  let cancelled = 0;
  for (const kind of kinds) {
    const handler: CancellableApprovalRequestHandler = handlers[kind];
    cancelled += handler.cancelWhere(
      (item) =>
        matchesCancelSelector(
          { kind, streamId: item.streamId || undefined },
          selector,
        ),
      selector.cause,
    );
  }
  return cancelled;
}
