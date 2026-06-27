// Approval-event interception per docs/prds/cli-tui-ink/10-architecture.md §9.
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

import type { RunCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { setCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  approvalPromptAllowed,
  humanInputDenialFeedback,
  immediateDecision,
  immediateDecisionForApproval,
  markApprovalDenied,
} from '@cli/runtime/approvalAdapter';
import {
  cliApprovalEventKind,
  isCliApprovalEvent,
  type CliApprovalEvent,
} from '@cli/runtime/approvalEvents';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  handleProgressViewBashApprovalAction,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
  setToolEditApprovalHandler,
} from '@tools/approval';
import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { assertNever } from '../assertNever';
import { notify } from '../notifications/terminalNotifier';
import { cliState } from './cliState';
import { setCliCodexSubscription } from './codexSubscription';
import {
  approvalPayloadStreamId,
  enqueueApproval,
  type ApprovalDecision,
  type ApprovalPayload,
} from './approvalQueue';

type ApprovalCoordinatorBridge = Pick<
  RunCoordinatorBridge,
  'cancelRetry' | 'resolvePlanApproval' | 'resolveProposal' | 'triggerRetry'
>;

/**
 * Install the typed approval pipeline. Returns an `unbind` callback that
 * restores the original emit + clears the tool-edit handler.
 */
export function installTuiApprovals(
  host: CliRuntimeHost,
  context: CliContext,
  coordinators: ApprovalCoordinatorBridge,
): () => void {
  const originalEmit = host.emit;
  host.emit = ((event, payload) => {
    // Approval events are intentionally NOT forwarded to originalEmit.
    // The underlying `createCliRuntimeHost.emit` chains through
    // `handleCliApprovalEvent`, which would re-handle the same approval
    // via the legacy stderr prompt — racing the TUI modal for the same
    // resolver. Non-approval events (status, usage, log) keep flowing
    // through the original chain.
    if (isCliApprovalEvent(event)) {
      routeApproval(
        event,
        payload as ProgressEventPayloads[CliApprovalEvent],
        context,
        host,
        coordinators,
      );
      return;
    }
    originalEmit(event, payload);
  }) as CliRuntimeHost['emit'];

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

function routeApproval(
  event: CliApprovalEvent,
  payload: ProgressEventPayloads[CliApprovalEvent],
  context: CliContext,
  host: CliRuntimeHost,
  coordinators: ApprovalCoordinatorBridge,
): void {
  switch (event) {
    case 'showBashPermission':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showBashPermission'],
        (bashPayload, decision) => {
          if (
            decision.accepted &&
            decision.bypass === 'bash' &&
            bashPayload.streamId
          ) {
            setBashApprovalSessionBypass(bashPayload.streamId, true, host);
          }
          dispatchBash(bashPayload, decision);
        },
      );
      return;
    case 'showPlanApproval':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showPlanApproval'],
        (planPayload, decision) =>
          dispatchPlan(coordinators, planPayload, decision),
      );
      return;
    case 'showAgentProposal':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showAgentProposal'],
        (proposalPayload, decision) =>
          dispatchProposal(coordinators, proposalPayload, decision),
      );
      return;
    case 'showRetryRequest':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showRetryRequest'],
        (retryPayload, decision) =>
          dispatchRetry(coordinators, retryPayload, decision),
      );
      return;
    case 'showExternalInquiry':
      // Human-input requests cannot be auto-answered in yolo mode, so they
      // share a policy helper with the non-TUI approval path.
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
    ApprovalPayload,
    { kind: K }
  >;
  void enqueueTuiApproval(queuePayload, host).then((decision) => {
    markIfRejected(context, decision);
    dispatch(payload, decision);
  });
}

export function enqueueTuiApproval(
  payload: ApprovalPayload,
  host: CliRuntimeHost,
): Promise<ApprovalDecision> {
  return enqueueApproval(payload, {
    onPresent: () => {
      const streamId = approvalPayloadStreamId(payload);
      if (streamId) host.emit('setActiveStream', { streamId });
      notify({ kind: 'approvalNeeded' });
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
  coordinators: ApprovalCoordinatorBridge,
  payload: ProgressEventPayloads['showPlanApproval'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
  coordinators.resolvePlanApproval(payload.approvalId, {
    action: decision.accepted ? (decision.planAction ?? 'approve') : 'reject',
    ...(feedback ? { feedback } : {}),
  });
}

function dispatchProposal(
  coordinators: ApprovalCoordinatorBridge,
  payload: ProgressEventPayloads['showAgentProposal'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
  coordinators.resolveProposal(payload.proposalId, {
    action: decision.accepted ? 'approve' : 'reject',
    ...(feedback ? { feedback } : {}),
  });
}

function dispatchRetry(
  coordinators: ApprovalCoordinatorBridge,
  payload: ProgressEventPayloads['showRetryRequest'],
  decision: ApprovalDecision,
): void {
  if (decision.accepted) {
    void applyRetryDecision(coordinators, payload, decision);
  } else {
    coordinators.cancelRetry(payload.streamId);
  }
}

async function applyRetryDecision(
  coordinators: ApprovalCoordinatorBridge,
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
  if (decision.disableChatGptSubscription) {
    await setCliCodexSubscription(false);
  }
  coordinators.triggerRetry(payload.streamId, decision.userMessage);
}

function handleExternalInquiry(
  payload: ProgressEventPayloads['showExternalInquiry'],
  context: CliContext,
  host: CliRuntimeHost,
): void {
  const threadId = payload.threadId;
  if (!threadId) return;

  if (!approvalPromptAllowed(context)) {
    const feedback = humanInputDenialFeedback(
      context,
      'External inquiry requires human input; yolo mode cannot synthesize an external answer.',
    );
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
  if (!approvalPromptAllowed(context)) {
    const feedback = humanInputDenialFeedback(
      context,
      'User question requires human input; yolo mode cannot synthesize an answer.',
    );
    void handleUserQuestionAction({
      requestId: payload.requestId,
      action: 'skip',
      feedback,
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
