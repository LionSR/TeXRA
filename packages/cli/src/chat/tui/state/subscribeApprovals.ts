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

import { runCoordinatorBridge } from '@agent/runtime/runCoordinators';
import { setCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  approvalPromptAllowed,
  humanInputDenialFeedback,
  immediateDecision,
  immediateDecisionForApproval,
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
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

import { assertNever } from '@utils/core';
import { lookupApiKey, isApiProvider } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { notify } from '../notifications/terminalNotifier';
import { cliState } from './cliState';
import { setCliCodexSubscription } from './codexSubscription';
import {
  approvalPayloadStreamId,
  enqueueApproval,
  type ApprovalDecision,
  type ApprovalPayload,
} from './approvalQueue';

// =========================================================================
// Retry auto-switch: skip the modal when a usable personal key exists
// =========================================================================

/** Check whether a usable personal API key is stored for a provider. */
async function hasUsablePersonalKey(provider: string): Promise<boolean> {
  if (!isApiProvider(provider)) return false;
  const key = await lookupApiKey(platform().secrets, provider);
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * When a retry is triggered by relay exhaustion or ChatGPT-subscription
 * limits, and the stored personal key is not the broken credential, switch
 * to personal keys and retry without showing the modal — matching the
 * progress-view behaviour in {@link ProgressApiKeyRetryController}.
 *
 * Returns the auto-switch decision, or `undefined` when the modal is needed
 * (no usable key stored, direct-key failure, or unknown provider).
 */
async function maybeAutoSwitchRetry(
  payload: ProgressEventPayloads['showRetryRequest'],
): Promise<ApprovalDecision | undefined> {
  if (!isCliApiSwitchableRetry(payload)) return undefined;

  const details = payload.errorDetails;
  // Upstream credit depletion means the stored direct key IS the broken
  // credential — the user must provide a changed key, so we cannot
  // auto-switch to the stored value.
  if (details?.isUpstreamCreditDepleted) return undefined;

  // ChatGPT-subscription exhaustion → the user needs an OpenAI key.
  // Relay exhaustion → use the provider from the error details if known.
  const provider = isCliChatGptSubscriptionRetry(payload)
    ? 'openai'
    : details?.provider;

  if (!provider || !isApiProvider(provider)) return undefined;

  const hasKey = await hasUsablePersonalKey(provider);
  if (!hasKey) return undefined;

  const isChatGptSubscription = isCliChatGptSubscriptionRetry(payload);
  return {
    accepted: true,
    apiMode: 'personal',
    ...(isChatGptSubscription ? { disableChatGptSubscription: true } : {}),
  };
}

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
    case 'showRetryRequest': {
      const retryPayload = payload as ProgressEventPayloads['showRetryRequest'];
      // Policy check (yolo/never). For 'ask' mode this returns undefined
      // so the user can decide; for auto modes it returns yolo(accept) or
      // never(reject) directly. When the failing request carries a
      // credential-exhausted / 401-403 error the policy also returns
      // undefined in interactive mode so the switch-to-personal affordance
      // remains available.
      const policy = immediateDecisionForApproval(
        'showRetryRequest',
        retryPayload,
        context,
      );
      if (policy) {
        dispatchRetry(retryPayload, policy);
        return;
      }
      // Relay / subscription exhaustion with a stored personal key →
      // switch and retry without showing the modal (matches progress-view
      // gate: ProgressApiKeyRetryController §hasAnyUsableKey).
      void (async () => {
        const autoDecision = await maybeAutoSwitchRetry(retryPayload);
        if (autoDecision) {
          await applyRetryDecision(retryPayload, autoDecision);
          return;
        }
        // No usable key available — show the modal so the user can enter one.
        routeWithPolicyForRetry(context, host, retryPayload);
      })();
      return;
    }
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

/**
 * Enqueue a retry approval for the TUI modal — only called after the
 * auto-switch check found no usable personal key, so the user needs to
 * see the retry prompt.
 */
function routeWithPolicyForRetry(
  context: CliContext,
  host: CliRuntimeHost,
  payload: ProgressEventPayloads['showRetryRequest'],
): void {
  const queuePayload: ApprovalPayload = { kind: 'retry', payload };
  void enqueueTuiApproval(queuePayload, host).then((decision) => {
    markIfRejected(context, decision);
    dispatchRetry(payload, decision);
  });
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
  payload: ProgressEventPayloads['showPlanApproval'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
  runCoordinatorBridge.resolvePlanApproval(payload.approvalId, {
    action: decision.accepted ? (decision.planAction ?? 'approve') : 'reject',
    ...(feedback ? { feedback } : {}),
  });
}

function dispatchProposal(
  payload: ProgressEventPayloads['showAgentProposal'],
  decision: ApprovalDecision,
): void {
  const feedback = feedbackOnReject(decision);
  runCoordinatorBridge.resolveProposal(payload.proposalId, {
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
    runCoordinatorBridge.cancelRetry(payload.streamId);
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
  runCoordinatorBridge.triggerRetry(payload.streamId, decision.userMessage);
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
