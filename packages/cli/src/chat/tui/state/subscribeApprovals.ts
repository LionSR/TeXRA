// Approval-event interception per docs/prd/cli-tui-ink/10-architecture.md §9.
//
// Wraps the runtime host so approval-kind events get diverted to the typed
// queue (-> ApprovalModal -> user) instead of the legacy stderr prompt.
// When the modal resolves, the *original* resolvers run unchanged.
//
// Tool-edit goes through `setToolEditApprovalHandler` (separate API since
// it returns a typed Promise<ToolEditApprovalResult>, not a fire-and-forget
// event).

import {
  cancelRetry,
  resolvePlanApproval,
  resolveProposal,
  triggerRetry,
} from '@agent/runtime/runCoordinators';
import {
  handleProgressViewBashApprovalAction,
  setToolEditApprovalHandler,
} from '@tools/approval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import type { CliRuntimeHost } from '../../../runtime/runtimeHost';
import { enqueueApproval, type ApprovalDecision } from './approvalQueue';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

/**
 * Install the typed approval pipeline. Returns an `unbind` callback that
 * restores the original emit + clears the tool-edit handler.
 */
export function installTuiApprovals(host: CliRuntimeHost): () => void {
  const originalEmit = host.emit;
  host.emit = ((event, payload) => {
    if (interceptApproval(event, payload)) return;
    return originalEmit(event, payload);
  }) as Emit;

  setToolEditApprovalHandler(async (request) => {
    const decision = await enqueueApproval({
      kind: 'toolEdit',
      request,
      resolve: () => {
        /* unused — modal calls `decide`, queue resolves the outer promise */
      },
    });
    return decision.accepted
      ? { accepted: true, appliedContent: request.proposedContent }
      : { accepted: false, userMessage: decision.userMessage };
  });

  return () => {
    host.emit = originalEmit;
    setToolEditApprovalHandler();
  };
}

function interceptApproval<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): boolean {
  switch (event) {
    case 'showBashPermission':
      void enqueueAndDispatch(
        {
          kind: 'bash',
          payload: payload as ProgressEventPayloads['showBashPermission'],
        },
        (d) =>
          dispatchBash(
            payload as ProgressEventPayloads['showBashPermission'],
            d,
          ),
      );
      return true;
    case 'showPlanApproval':
      void enqueueAndDispatch(
        {
          kind: 'plan',
          payload: payload as ProgressEventPayloads['showPlanApproval'],
        },
        (d) =>
          dispatchPlan(payload as ProgressEventPayloads['showPlanApproval'], d),
      );
      return true;
    case 'showAgentProposal':
      void enqueueAndDispatch(
        {
          kind: 'proposal',
          payload: payload as ProgressEventPayloads['showAgentProposal'],
        },
        (d) =>
          dispatchProposal(
            payload as ProgressEventPayloads['showAgentProposal'],
            d,
          ),
      );
      return true;
    case 'showRetryRequest':
      void enqueueAndDispatch(
        {
          kind: 'retry',
          payload: payload as ProgressEventPayloads['showRetryRequest'],
        },
        (d) =>
          dispatchRetry(
            payload as ProgressEventPayloads['showRetryRequest'],
            d,
          ),
      );
      return true;
    case 'showExternalInquiry':
      void enqueueAndDispatch(
        {
          kind: 'externalInquiry',
          payload: payload as ProgressEventPayloads['showExternalInquiry'],
        },
        (d) =>
          dispatchExternalInquiry(
            payload as ProgressEventPayloads['showExternalInquiry'],
            d,
          ),
      );
      return true;
    default:
      return false;
  }
}

async function enqueueAndDispatch(
  payload: Parameters<typeof enqueueApproval>[0],
  dispatch: (decision: ApprovalDecision) => void,
): Promise<void> {
  const decision = await enqueueApproval(payload);
  dispatch(decision);
}

function userMessage(decision: ApprovalDecision): string | undefined {
  return decision.accepted ? undefined : decision.userMessage;
}

function dispatchBash(
  payload: ProgressEventPayloads['showBashPermission'],
  decision: ApprovalDecision,
): void {
  void handleProgressViewBashApprovalAction({
    requestId: payload.requestId,
    action: decision.accepted ? 'approve' : 'reject',
    feedback: userMessage(decision),
  });
}

function dispatchPlan(
  payload: ProgressEventPayloads['showPlanApproval'],
  decision: ApprovalDecision,
): void {
  const feedback = userMessage(decision);
  resolvePlanApproval(payload.approvalId, {
    action: decision.accepted ? 'approve' : 'reject',
    ...(feedback ? { feedback } : {}),
  });
}

function dispatchProposal(
  payload: ProgressEventPayloads['showAgentProposal'],
  decision: ApprovalDecision,
): void {
  const feedback = userMessage(decision);
  resolveProposal(payload.proposalId, {
    action: decision.accepted ? 'approve' : 'reject',
    ...(feedback ? { feedback } : {}),
  });
}

function dispatchRetry(
  payload: ProgressEventPayloads['showRetryRequest'],
  decision: ApprovalDecision,
): void {
  if (decision.accepted) {
    triggerRetry(payload.streamId);
  } else {
    cancelRetry(payload.streamId);
  }
}

function dispatchExternalInquiry(
  payload: ProgressEventPayloads['showExternalInquiry'],
  decision: ApprovalDecision,
): void {
  void handleExternalInquiryAction({
    requestId: payload.requestId,
    action: decision.accepted ? 'submit' : 'reject',
    answer: decision.accepted ? decision.userMessage : undefined,
  });
}
