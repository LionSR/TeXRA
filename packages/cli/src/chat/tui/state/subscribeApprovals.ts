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
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import {
  handleProgressViewBashApprovalAction,
  setToolEditApprovalHandler,
} from '@tools/approval';
import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import {
  denyMessage,
  immediateDecision,
  markApprovalDenied,
  type ApprovalDecision as PolicyDecision,
} from '../../../runtime/approvalAdapter';
import { assertNever } from '../assertNever';
import { enqueueApproval, type ApprovalDecision } from './approvalQueue';
import type { CliContext } from '../../../runtime/cliContext';
import type { CliRuntimeHost } from '../../../runtime/runtimeHost';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;
type ApprovalEvent =
  | 'showBashPermission'
  | 'showPlanApproval'
  | 'showAgentProposal'
  | 'showRetryRequest'
  | 'showExternalInquiry'
  | 'showUserQuestion';

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
    // Approval events are intentionally NOT forwarded to originalEmit.
    // The underlying `createCliRuntimeHost.emit` chains through
    // `handleCliApprovalEvent`, which would re-handle the same approval
    // via the legacy stderr prompt — racing the TUI modal for the same
    // resolver. Non-approval events (status, usage, log) keep flowing
    // through the original chain.
    if (isApprovalEvent(event)) {
      routeApproval(
        event,
        payload as ProgressEventPayloads[ApprovalEvent],
        context,
      );
      return;
    }
    originalEmit(event, payload);
  }) as Emit;

  setToolEditApprovalHandler(async (request) => {
    const policy = immediateDecision(context);
    if (policy) {
      return policy.accepted
        ? { accepted: true, appliedContent: request.proposedContent }
        : { accepted: false, userMessage: policy.userMessage };
    }
    const decision = await enqueueApproval({ kind: 'toolEdit', request });
    markIfRejected(context, decision);
    return decision.accepted
      ? { accepted: true, appliedContent: request.proposedContent }
      : { accepted: false, userMessage: decision.userMessage };
  });

  return () => {
    host.emit = originalEmit;
    setToolEditApprovalHandler();
  };
}

const APPROVAL_EVENTS = new Set<ApprovalEvent>([
  'showBashPermission',
  'showPlanApproval',
  'showAgentProposal',
  'showRetryRequest',
  'showExternalInquiry',
  'showUserQuestion',
]);

function isApprovalEvent(event: ProgressEvent): event is ApprovalEvent {
  return APPROVAL_EVENTS.has(event as ApprovalEvent);
}

function routeApproval(
  event: ApprovalEvent,
  payload: ProgressEventPayloads[ApprovalEvent],
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
      // External inquiry has bespoke policy semantics (legacy adapter uses
      // `action: 'skip'` for both yolo *and* never with different feedback
      // strings), so it bypasses the generic `routeWithPolicy` ladder.
      handleExternalInquiry(
        payload as ProgressEventPayloads['showExternalInquiry'],
        context,
      );
      return;
    case 'showUserQuestion':
      handleUserQuestion(
        payload as ProgressEventPayloads['showUserQuestion'],
        context,
      );
      return;
    default:
      assertNever(event, 'Unhandled TUI approval event');
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
    markIfRejected(context, decision);
    dispatch(payload, decision);
  });
}

function feedbackOnReject(decision: ApprovalDecision): string | undefined {
  return decision.accepted ? undefined : decision.userMessage;
}

function markIfRejected(context: CliContext, decision: ApprovalDecision): void {
  if (!decision.accepted) markApprovalDenied(context);
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

function handleExternalInquiry(
  payload: ProgressEventPayloads['showExternalInquiry'],
  context: CliContext,
): void {
  const threadId = payload.threadId;
  if (!threadId) return;

  const policy = immediateDecision(context);
  if (policy) {
    const feedback =
      context.approvalPolicy === 'yolo'
        ? 'External inquiry requires human input; yolo mode cannot synthesize an external answer.'
        : denyMessage(context.approvalPolicy);
    void handleExternalInquiryAction({ action: 'drop', threadId, feedback });
    return;
  }
  void enqueueApproval({ kind: 'externalInquiry', payload }).then(
    (decision) => {
      markIfRejected(context, decision);
      // User-accept with text submits an answer; empty text, reject, and
      // modal-cancel all drop the durable inquiry thread.
      if (decision.accepted && decision.userMessage) {
        void handleExternalInquiryAction({
          action: 'submit',
          threadId,
          answer: decision.userMessage,
        });
        return;
      }
      void handleExternalInquiryAction({
        action: 'drop',
        threadId,
        feedback: decision.userMessage || 'No answer provided.',
      });
    },
  );
}

function handleUserQuestion(
  payload: ProgressEventPayloads['showUserQuestion'],
  context: CliContext,
): void {
  const policy = immediateDecision(context);
  const feedback = policy
    ? context.approvalPolicy === 'yolo'
      ? 'User question requires human input; yolo mode cannot synthesize an answer.'
      : denyMessage(context.approvalPolicy)
    : 'User questions are not yet supported in the CLI TUI.';
  void handleUserQuestionAction({
    requestId: payload.requestId,
    action: 'skip',
    feedback,
  });
}
