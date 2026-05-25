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
  denyMessage,
  immediateDecision,
  immediateDecisionForApproval,
  markApprovalDenied,
} from '@cli/runtime/approvalAdapter';
import { setCliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import {
  handleProgressViewBashApprovalAction,
  setToolEditApprovalSessionBypass,
  setToolEditApprovalHandler,
} from '@tools/approval';
import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { assertNever } from '../assertNever';
import { cliState } from './cliState';
import {
  enqueueApproval,
  type ApprovalDecision,
  type ApprovalPayload,
} from './approvalQueue';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

const APPROVAL_EVENTS = [
  'showBashPermission',
  'showPlanApproval',
  'showAgentProposal',
  'showRetryRequest',
  'showExternalInquiry',
  'showUserQuestion',
] as const;

type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];

const APPROVAL_EVENT_SET: ReadonlySet<ProgressEvent> = new Set(APPROVAL_EVENTS);

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
        host,
      );
      return;
    }
    originalEmit(event, payload);
  }) as Emit;

  setToolEditApprovalHandler(async (request) => {
    let decision: ApprovalDecision | undefined = immediateDecision(context);
    if (!decision) {
      decision = await enqueueTuiApproval({ kind: 'toolEdit', request }, host);
      markIfRejected(context, decision);
    }
    if (
      decision.accepted &&
      decision.bypass === 'toolEdit' &&
      request.streamId
    ) {
      setToolEditApprovalSessionBypass(request.streamId, true, host);
    }
    return decision.accepted
      ? { accepted: true, appliedContent: request.proposedContent }
      : { accepted: false, userMessage: decision.userMessage };
  });

  return () => {
    host.emit = originalEmit;
    setToolEditApprovalHandler();
  };
}

function isApprovalEvent(event: ProgressEvent): event is ApprovalEvent {
  return APPROVAL_EVENT_SET.has(event);
}

function routeApproval(
  event: ApprovalEvent,
  payload: ProgressEventPayloads[ApprovalEvent],
  context: CliContext,
  host: CliRuntimeHost,
): void {
  switch (event) {
    case 'showBashPermission':
      routeWithPolicy(
        context,
        host,
        'bash',
        payload as ProgressEventPayloads['showBashPermission'],
        (bashPayload, decision) => {
          if (
            decision.accepted &&
            decision.bypass === 'toolEdit' &&
            bashPayload.streamId
          ) {
            setToolEditApprovalSessionBypass(bashPayload.streamId, true, host);
          }
          dispatchBash(bashPayload, decision);
        },
      );
      return;
    case 'showPlanApproval':
      routeWithPolicy(
        context,
        host,
        'plan',
        payload as ProgressEventPayloads['showPlanApproval'],
        dispatchPlan,
      );
      return;
    case 'showAgentProposal':
      routeWithPolicy(
        context,
        host,
        'proposal',
        payload as ProgressEventPayloads['showAgentProposal'],
        dispatchProposal,
      );
      return;
    case 'showRetryRequest':
      routeWithPolicy(
        context,
        host,
        'retry',
        payload as ProgressEventPayloads['showRetryRequest'],
        dispatchRetry,
      );
      return;
    case 'showExternalInquiry':
      // External inquiry has bespoke policy semantics (legacy adapter uses
      // `action: 'skip'` for both yolo *and* never with different feedback
      // strings), so it bypasses the generic `routeWithPolicy` ladder.
      handleExternalInquiry(
        payload as ProgressEventPayloads['showExternalInquiry'],
        context,
        host,
      );
      return;
    case 'showUserQuestion':
      handleUserQuestion(
        payload as ProgressEventPayloads['showUserQuestion'],
        context,
        host,
      );
      return;
    default:
      assertNever(event, 'Unhandled TUI approval event');
  }
}

function routeWithPolicy<K extends 'bash' | 'plan' | 'proposal' | 'retry', P>(
  context: CliContext,
  host: CliRuntimeHost,
  kind: K,
  payload: P,
  dispatch: (payload: P, decision: ApprovalDecision) => void,
): void {
  const policy =
    kind === 'retry'
      ? immediateDecisionForApproval(
          'showRetryRequest',
          payload as ProgressEventPayloads['showRetryRequest'],
          context,
        )
      : immediateDecision(context);
  if (policy) {
    dispatch(payload, policy);
    return;
  }
  // The Extract<...> cast narrows the queue payload to the kind we picked;
  // each dispatcher already trusts its payload shape via its own signature.
  const queuePayload = { kind, payload } as Extract<
    Parameters<typeof enqueueApproval>[0],
    { kind: K }
  >;
  void enqueueTuiApproval(queuePayload, host).then((decision) => {
    markIfRejected(context, decision);
    dispatch(payload, decision);
  });
}

export function approvalPayloadStreamId(
  payload: ApprovalPayload,
): string | undefined {
  switch (payload.kind) {
    case 'bash':
    case 'plan':
    case 'proposal':
    case 'retry':
    case 'externalInquiry':
    case 'userQuestion':
      return payload.payload.streamId || undefined;
    case 'toolEdit':
      return payload.request.streamId || undefined;
    default:
      assertNever(payload, 'Unhandled approval payload kind');
  }
}

function enqueueTuiApproval(
  payload: ApprovalPayload,
  host: CliRuntimeHost,
): Promise<ApprovalDecision> {
  return enqueueApproval(payload, {
    onPresent: () => {
      const streamId = approvalPayloadStreamId(payload);
      if (streamId) host.emit('setActiveStream', { streamId });
    },
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
    void applyRetryDecision(payload, decision);
  } else {
    cancelRetry(payload.streamId);
  }
}

async function applyRetryDecision(
  payload: ProgressEventPayloads['showRetryRequest'],
  decision: ApprovalDecision,
): Promise<void> {
  if (decision.apiMode) {
    await setCliApiMode(decision.apiMode);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      apiMode: decision.apiMode,
    });
  }
  triggerRetry(payload.streamId, decision.userMessage);
}

function handleExternalInquiry(
  payload: ProgressEventPayloads['showExternalInquiry'],
  context: CliContext,
  host: CliRuntimeHost,
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
  void enqueueTuiApproval({ kind: 'externalInquiry', payload }, host).then(
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
  host: CliRuntimeHost,
): void {
  const policy = immediateDecision(context);
  if (policy) {
    void handleUserQuestionAction({
      requestId: payload.requestId,
      action: 'skip',
      feedback: userQuestionFeedback(context),
    });
    return;
  }

  void enqueueTuiApproval({ kind: 'userQuestion', payload }, host).then(
    (decision) => {
      markIfRejected(context, decision);
      if (decision.accepted && decision.userQuestionAnswers) {
        void handleUserQuestionAction({
          requestId: payload.requestId,
          action: 'submit',
          answers: decision.userQuestionAnswers,
        });
        return;
      }
      void handleUserQuestionAction({
        requestId: payload.requestId,
        action: 'skip',
        feedback: decision.userMessage || 'User question skipped by user.',
      });
    },
  );
}

function userQuestionFeedback(context: CliContext): string {
  if (context.approvalPolicy === 'yolo') {
    return 'User question requires human input; yolo mode cannot synthesize an answer.';
  }
  return denyMessage(context.approvalPolicy);
}
