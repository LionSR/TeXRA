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
// Tool-edit goes through the runtime approval handler boundary (separate API
// since it returns a typed Promise<RuntimeToolEditApprovalResult>, not a
// fire-and-forget event).

import {
  applyRuntimeApprovalDecisionBypass,
  resolveRuntimeBashApproval,
  setRuntimeToolEditApprovalHandler,
} from '@agent/runtime/approvalCommands';
import {
  resolveRuntimeExternalInquiry,
  resolveRuntimeUserQuestion,
} from '@agent/runtime/humanInputCommands';
import {
  cancelRuntimeRetry,
  resolveRuntimePlanApproval,
  resolveRuntimeProposal,
  triggerRuntimeRetry,
} from '@agent/runtime/runCoordinatorCommands';
import {
  approvalPromptAllowed,
  humanInputDenialFeedback,
  immediateDecision,
  immediateDecisionForApproval,
  markApprovalDenied,
} from '@cli/runtime/approvalAdapter';
import { setCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  cliApprovalEventKind,
  isCliApprovalEvent,
  type CliApprovalEvent,
} from '@cli/runtime/approvalEvents';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { assertNever } from '@utils/core';
import { notify } from '../notifications/terminalNotifier';
import { cliState } from './cliState';
import {
  approvalPayloadStreamId,
  enqueueApproval,
  type ApprovalDecision,
  type ApprovalPayload,
} from './approvalQueue';
import { setCliCodexSubscription } from './codexSubscription';

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
    if (isCliApprovalEvent(event)) {
      routeApproval(
        event,
        payload as ProgressEventPayloads[CliApprovalEvent],
        context,
        host,
      );
      return;
    }
    originalEmit(event, payload);
  }) as CliRuntimeHost['emit'];

  setRuntimeToolEditApprovalHandler(async (request) => {
    let decision: ApprovalDecision | undefined = immediateDecision(context);
    if (!decision) {
      decision = await enqueueTuiApproval({ kind: 'toolEdit', request }, host);
      markIfRejected(context, decision);
    }
    applyRuntimeApprovalDecisionBypass({
      streamId: request.streamId,
      accepted: decision.accepted,
      bypass: decision.bypass,
      runtimeHost: host,
    });
    return decision.accepted
      ? { accepted: true, appliedContent: request.proposedContent }
      : { accepted: false, userMessage: decision.userMessage };
  });

  return () => {
    host.emit = originalEmit;
    setRuntimeToolEditApprovalHandler();
  };
}

function routeApproval(
  event: CliApprovalEvent,
  payload: ProgressEventPayloads[CliApprovalEvent],
  context: CliContext,
  host: CliRuntimeHost,
): void {
  switch (event) {
    case 'showBashPermission':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showBashPermission'],
        (bashPayload, decision) => {
          applyRuntimeApprovalDecisionBypass({
            streamId: bashPayload.streamId,
            accepted: decision.accepted,
            bypass: decision.bypass,
            runtimeHost: host,
          });
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
        dispatchPlan,
      );
      return;
    case 'showAgentProposal':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showAgentProposal'],
        dispatchProposal,
      );
      return;
    case 'showRetryRequest':
      routeWithPolicy(
        context,
        host,
        cliApprovalEventKind(event),
        payload as ProgressEventPayloads['showRetryRequest'],
        dispatchRetry,
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
  void resolveRuntimeBashApproval({
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
  resolveRuntimePlanApproval({
    approvalId: payload.approvalId,
    result: {
      action: decision.accepted ? (decision.planAction ?? 'approve') : 'reject',
      ...(feedback ? { feedback } : {}),
    },
  });
}

function dispatchProposal(
  payload: ProgressEventPayloads['showAgentProposal'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
  resolveRuntimeProposal({
    proposalId: payload.proposalId,
    result: {
      action: decision.accepted ? 'approve' : 'reject',
      ...(feedback ? { feedback } : {}),
    },
  });
}

function dispatchRetry(
  payload: ProgressEventPayloads['showRetryRequest'],
  decision: ApprovalDecision,
): void {
  if (decision.accepted) {
    void applyRetryDecision(payload, decision);
  } else {
    cancelRuntimeRetry({ streamId: payload.streamId });
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
  if (decision.disableChatGptSubscription) {
    await setCliCodexSubscription(false);
  }
  triggerRuntimeRetry({
    streamId: payload.streamId,
    feedback: decision.userMessage,
  });
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
    void resolveRuntimeExternalInquiry({ action: 'drop', threadId, feedback });
    return;
  }
  void enqueueTuiApproval({ kind: 'externalInquiry', payload }, host).then(
    (decision) => {
      markIfRejected(context, decision);
      // User-accept with text submits an answer; empty text, reject, and
      // modal-cancel all drop the durable inquiry thread.
      if (decision.accepted && decision.userMessage) {
        void resolveRuntimeExternalInquiry({
          action: 'submit',
          threadId,
          answer: decision.userMessage,
        });
        return;
      }
      void resolveRuntimeExternalInquiry({
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
    void resolveRuntimeUserQuestion({
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
        void resolveRuntimeUserQuestion({
          requestId: payload.requestId,
          action: 'submit',
          answers: decision.userQuestionAnswers,
        });
        return;
      }
      void resolveRuntimeUserQuestion({
        requestId: payload.requestId,
        action: 'skip',
        feedback: decision.userMessage || 'User question skipped by user.',
      });
    },
  );
}
