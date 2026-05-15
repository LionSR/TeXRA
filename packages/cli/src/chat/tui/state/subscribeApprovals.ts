// Approval-event interception per docs/prd/cli-tui-ink/10-architecture.md §9.
//
// Wraps the runtime host so approval-kind events get diverted to the typed
// queue (-> ApprovalModal -> user) instead of the legacy stderr prompt.
// When the modal resolves, the *original* resolvers run unchanged.
//
// Policy is honored *before* the modal is shown — `immediateDecision` runs
// first so `--approval-policy yolo` auto-approves without a modal, and
// `never` auto-rejects with `denyMessage(...)`. Only `ask` (or interactive
// non-print) reaches the queue.
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

import {
  immediateDecision,
  type ApprovalDecision as PolicyDecision,
} from '../../../runtime/approvalAdapter';
import type { CliContext } from '../../../runtime/cliContext';
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
export function installTuiApprovals(
  host: CliRuntimeHost,
  context: CliContext,
): () => void {
  const originalEmit = host.emit;
  host.emit = ((event, payload) => {
    // Always forward the event through the original chain (cliState patcher,
    // structured logger, ndjson sink, …) — interception is *additive*.
    originalEmit(event, payload);
    routeApproval(event, payload, context);
  }) as Emit;

  setToolEditApprovalHandler(async (request) => {
    const policy = immediateDecision(context);
    if (policy) {
      return policy.accepted
        ? { accepted: true, appliedContent: request.proposedContent }
        : { accepted: false, userMessage: policy.userMessage };
    }
    const decision = await enqueueApproval({
      kind: 'toolEdit',
      request,
      resolve: () => {
        /* unused — the queue resolves the outer promise via `decide` */
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

function routeApproval<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): void {
  switch (event) {
    case 'showBashPermission':
      routeWithPolicy(
        context,
        dispatchBash,
        payload as ProgressEventPayloads['showBashPermission'],
        (p) => ({
          kind: 'bash',
          payload: p,
        }),
      );
      return;
    case 'showPlanApproval':
      routeWithPolicy(
        context,
        dispatchPlan,
        payload as ProgressEventPayloads['showPlanApproval'],
        (p) => ({
          kind: 'plan',
          payload: p,
        }),
      );
      return;
    case 'showAgentProposal':
      routeWithPolicy(
        context,
        dispatchProposal,
        payload as ProgressEventPayloads['showAgentProposal'],
        (p) => ({
          kind: 'proposal',
          payload: p,
        }),
      );
      return;
    case 'showRetryRequest':
      routeWithPolicy(
        context,
        dispatchRetry,
        payload as ProgressEventPayloads['showRetryRequest'],
        (p) => ({
          kind: 'retry',
          payload: p,
        }),
      );
      return;
    case 'showExternalInquiry':
      routeWithPolicy(
        context,
        dispatchExternalInquiry,
        payload as ProgressEventPayloads['showExternalInquiry'],
        (p) => ({ kind: 'externalInquiry', payload: p }),
      );
      return;
    default:
      return;
  }
}

function routeWithPolicy<P>(
  context: CliContext,
  dispatch: (payload: P, decision: ApprovalDecision) => void,
  payload: P,
  toQueuePayload: (p: P) => Parameters<typeof enqueueApproval>[0],
): void {
  const policy: PolicyDecision | undefined = immediateDecision(context);
  if (policy) {
    dispatch(payload, policy);
    return;
  }
  void enqueueApproval(toQueuePayload(payload)).then((decision) => {
    dispatch(payload, decision);
  });
}

function feedbackOnReject(decision: ApprovalDecision): string | undefined {
  return decision.accepted ? undefined : decision.userMessage;
}

function dispatchBash(
  payload: ProgressEventPayloads['showBashPermission'],
  decision: ApprovalDecision,
): void {
  void handleProgressViewBashApprovalAction({
    requestId: payload.requestId,
    action: decision.accepted ? 'approve' : 'reject',
    feedback: feedbackOnReject(decision),
  });
}

function dispatchPlan(
  payload: ProgressEventPayloads['showPlanApproval'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
  resolvePlanApproval(payload.approvalId, {
    action: decision.accepted ? 'approve' : 'reject',
    ...(feedback ? { feedback } : {}),
  });
}

function dispatchProposal(
  payload: ProgressEventPayloads['showAgentProposal'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
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
    triggerRetry(payload.streamId, decision.userMessage);
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
    feedback: decision.accepted ? undefined : decision.userMessage,
  });
}
