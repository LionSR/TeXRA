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
// Tool-edit is part of this port because it returns a typed
// Promise<ToolEditApprovalResult>, not a fire-and-forget event.

import { nanoid } from 'nanoid';

import { platform } from '@platform/platform';
import type {
  HostBashApprovalRequest,
  HostBashApprovalResult,
  HostInteractionOptions,
  HostInteractions,
  HostRetryRequest,
} from '@agent/runtime/HostInteractions';
import type { PlanApprovalResult } from '@agent/runtime/PlanApprovalCoordinator';
import type { ProposalResult } from '@agent/runtime/AgentProposalCoordinator';
import type { RetryResult } from '@agent/runtime/RetryRequestCoordinator';
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
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  API_PROVIDERS,
  lookupApiKey,
  isApiProvider,
  type ApiProvider,
} from '@model/apiProviders';
import { isUpstreamCreditDepletedError } from '@shared/schemas';
import {
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { notify } from '../notifications/terminalNotifier';
import { patchSessionMeta } from './cliState/sessionSlice';
import { setCliCodexSubscription } from './codexSubscription';
import {
  approvalPayloadStreamId,
  clearApprovalsWhere,
  clearRetryApprovalsForStream,
  enqueueApproval,
  onApprovalsCleared,
  type ApprovalDecision,
  type ApprovalPayload,
} from './approvalQueue';

// =========================================================================
// Retry auto-switch: skip the modal when a usable personal key exists
// =========================================================================

/** Check whether a usable personal API key is stored for a provider. */
async function hasUsablePersonalKey(provider: ApiProvider): Promise<boolean> {
  const key = await lookupApiKey(platform().secrets, provider);
  return typeof key === 'string' && key.trim().length > 0;
}

/**
 * When a retry is triggered by relay exhaustion or ChatGPT-subscription
 * limits, and the stored personal key is not the broken credential, switch
 * to personal keys and retry without showing the modal — matching the
 * progress-view API-key retry behaviour.
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
  if (isUpstreamCreditDepletedError(details)) return undefined;

  // ChatGPT-subscription exhaustion -> the user needs an OpenAI key.
  // Relay exhaustion -> use the provider from error details when known;
  // provider-less relay failures can use any configured personal key.
  const isChatGptSubscription = isCliChatGptSubscriptionRetry(payload);
  let providers: readonly ApiProvider[];
  if (isChatGptSubscription) {
    providers = ['openai'];
  } else if (details?.provider) {
    providers = isApiProvider(details.provider) ? [details.provider] : [];
  } else {
    providers = API_PROVIDERS;
  }
  if (providers.length === 0) return undefined;

  const hasKey = (
    await Promise.all(
      providers.map((provider) => hasUsablePersonalKey(provider)),
    )
  ).some(Boolean);
  if (!hasKey) return undefined;

  return {
    accepted: true,
    apiMode: 'personal',
    ...(isChatGptSubscription ? { disableChatGptSubscription: true } : {}),
  };
}

/**
 * Create the typed approval pipeline for the active TUI session.
 */
export function createTuiHostInteractions(
  host: CliRuntimeHost,
  context: CliContext,
): HostInteractions {
  const retryRoutes = createRetryRouteState();
  const disposeApprovalClearListener = onApprovalsCleared(() => {
    invalidateRetryRoutes(retryRoutes, { cancel: true });
  });

  return {
    async requestToolEditApproval(request) {
      let decision: ApprovalDecision | undefined = immediateDecision(context);
      if (!decision) {
        decision = await enqueueTuiApproval(
          { kind: 'toolEdit', payload: request },
          host,
        );
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
    },
    requestBashApproval(request) {
      return requestBashInteraction(request, context, host);
    },
    requestPlanApproval(request, options) {
      return withInteractionTimeout(
        requestPlanInteraction(request, context, host),
        options,
        { action: 'timeout' },
        () =>
          clearApprovalsWhere(
            (payload) =>
              payload.kind === 'plan' &&
              payload.payload.approvalId === request.approvalId,
            NEUTRAL_TIMEOUT_DECISION,
          ),
      );
    },
    requestAgentProposal(request, options) {
      return withInteractionTimeout(
        requestProposalInteraction(request, context, host),
        options,
        { action: 'timeout' },
        () =>
          clearApprovalsWhere(
            (payload) =>
              payload.kind === 'proposal' &&
              payload.payload.proposalId === request.proposalId,
            NEUTRAL_TIMEOUT_DECISION,
          ),
      );
    },
    requestRetry(request, options) {
      return withInteractionTimeout(
        requestRetryInteraction(request, context, host, retryRoutes),
        options,
        { action: 'timeout' },
        () => {
          settleRetryRoute(retryRoutes, request.streamId, {
            action: 'timeout',
          });
          clearRetryApprovalsForStream(request.streamId);
        },
      );
    },
    askUserQuestion(request) {
      return requestUserQuestionInteraction(request, context, host);
    },
    openExternalInquiry(request) {
      return openExternalInquiryInteraction(request, context, host);
    },
    handleProgressEvent: () => false,
    pending: () => [],
    resolve: () => false,
    cancelForStream(streamId) {
      cancelRetryRoute(retryRoutes, streamId);
      clearRetryApprovalsForStream(streamId);
    },
    dispose() {
      invalidateRetryRoutes(retryRoutes, { cancel: true });
      disposeApprovalClearListener();
    },
  };
}

/**
 * Retry auto-switches need an async key lookup before the modal appears.
 * Track the latest route per stream so a stale lookup cannot switch API mode
 * or trigger an older retry after a newer retry request replaced it.
 */
interface ActiveRetryRoute {
  readonly routeId: symbol;
  readonly settle?: (result: RetryResult) => void;
}

interface RetryRouteState {
  readonly activeRetryRoutes: Map<string, ActiveRetryRoute>;
}

const NEUTRAL_TIMEOUT_DECISION: ApprovalDecision = {
  accepted: true,
  userMessage: 'Approval request timed out.',
};

function validTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs);
}

function withInteractionTimeout<T>(
  promise: Promise<T>,
  options: HostInteractionOptions | undefined,
  timeoutResult: T,
  onTimeout: () => void,
): Promise<T> {
  const timeoutMs = validTimeoutMs(options?.timeoutMs);
  if (timeoutMs == null) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      resolve(timeoutResult);
    }, timeoutMs);

    promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createRetryRouteState(): RetryRouteState {
  return { activeRetryRoutes: new Map() };
}

function isActiveRetryRoute(
  state: RetryRouteState,
  streamId: string,
  routeId: symbol,
): boolean {
  return state.activeRetryRoutes.get(streamId)?.routeId === routeId;
}

function cancelRetryRoute(state: RetryRouteState, streamId: string): void {
  settleRetryRoute(state, streamId, { action: 'cancel' });
}

function settleRetryRoute(
  state: RetryRouteState,
  streamId: string,
  result: RetryResult,
): void {
  const route = state.activeRetryRoutes.get(streamId);
  if (!route) return;
  state.activeRetryRoutes.delete(streamId);
  route.settle?.(result);
}

function invalidateRetryRoutes(
  state: RetryRouteState,
  options: { cancel: boolean },
): void {
  const streamIds = [...state.activeRetryRoutes.keys()];
  for (const streamId of streamIds) {
    if (options.cancel) {
      cancelRetryRoute(state, streamId);
    } else {
      state.activeRetryRoutes.delete(streamId);
    }
  }
}

interface RouteWithPolicyOptions<P> {
  beforeQueue?: (payload: P) => Promise<ApprovalDecision | undefined>;
  isCurrent?: () => boolean;
}

async function decideWithPolicy<
  K extends 'bash' | 'plan' | 'proposal' | 'retry',
  P,
>(
  context: CliContext,
  host: CliRuntimeHost,
  kind: K,
  payload: P,
  options: RouteWithPolicyOptions<P> = {},
): Promise<ApprovalDecision> {
  const policy =
    kind === 'retry'
      ? immediateDecisionForApproval(
          'showRetryRequest',
          payload as ProgressEventPayloads['showRetryRequest'],
          context,
        )
      : immediateDecision(context);
  if (policy) return policy;

  let autoDecision: ApprovalDecision | undefined;
  if (options.beforeQueue) {
    try {
      autoDecision = await options.beforeQueue(payload);
    } catch {
      autoDecision = undefined;
    }
    if (options.isCurrent && !options.isCurrent()) {
      return { accepted: false, userMessage: 'Approval request was replaced.' };
    }
    if (autoDecision) return autoDecision;
  }

  try {
    const queuePayload = { kind, payload } as Extract<
      ApprovalPayload,
      { kind: K }
    >;
    const decision = await enqueueTuiApproval(queuePayload, host);
    if (options.isCurrent && !options.isCurrent()) {
      return { accepted: false, userMessage: 'Approval request was replaced.' };
    }
    markIfRejected(context, decision);
    return decision;
  } catch {
    const decision: ApprovalDecision = {
      accepted: false,
      userMessage: 'CLI approval prompt failed.',
    };
    markIfRejected(context, decision);
    return decision;
  }
}

async function requestBashInteraction(
  request: HostBashApprovalRequest,
  context: CliContext,
  host: CliRuntimeHost,
): Promise<HostBashApprovalResult> {
  const payload: ProgressEventPayloads['showBashPermission'] = {
    requestId: `bash-${nanoid()}`,
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    allowBypass: true,
    streamId: request.streamId ?? '',
  };
  const decision = await decideWithPolicy(context, host, 'bash', payload);
  if (decision.accepted && decision.bypass === 'bash' && request.streamId) {
    setBashApprovalSessionBypass(request.streamId, true, host);
  }
  return {
    accepted: decision.accepted,
    userMessage: feedbackOnReject(decision),
  };
}

async function requestPlanInteraction(
  request: ProgressEventPayloads['showPlanApproval'],
  context: CliContext,
  host: CliRuntimeHost,
): Promise<PlanApprovalResult> {
  const decision = await decideWithPolicy(context, host, 'plan', request);
  const feedback = feedbackOnReject(decision);
  return decision.accepted
    ? { action: decision.planAction ?? 'approve' }
    : { action: 'reject', ...(feedback ? { feedback } : {}) };
}

async function requestProposalInteraction(
  request: ProgressEventPayloads['showAgentProposal'],
  context: CliContext,
  host: CliRuntimeHost,
): Promise<ProposalResult> {
  const decision = await decideWithPolicy(context, host, 'proposal', request);
  const feedback = feedbackOnReject(decision);
  return decision.accepted
    ? { action: 'approve' }
    : { action: 'reject', ...(feedback ? { feedback } : {}) };
}

async function requestRetryInteraction(
  request: HostRetryRequest,
  context: CliContext,
  host: CliRuntimeHost,
  retryRoutes: RetryRouteState,
): Promise<RetryResult> {
  cancelRetryRoute(retryRoutes, request.streamId);
  const routeId = Symbol(request.streamId);
  clearRetryApprovalsForStream(request.streamId);

  return await new Promise<RetryResult>((resolve) => {
    retryRoutes.activeRetryRoutes.set(request.streamId, {
      routeId,
      settle: resolve,
    });
    const isCurrent = () =>
      isActiveRetryRoute(retryRoutes, request.streamId, routeId);
    const finish = () => {
      if (isCurrent()) retryRoutes.activeRetryRoutes.delete(request.streamId);
    };

    void (async () => {
      const decision = await decideWithPolicy(context, host, 'retry', request, {
        beforeQueue: maybeAutoSwitchRetry,
        isCurrent,
      });
      if (!isCurrent()) return;
      if (
        decision.accepted &&
        (decision.apiMode || decision.disableChatGptSubscription)
      ) {
        clearRetryApprovalsForStream(request.streamId);
      }
      if (!decision.accepted) {
        resolve({ action: 'cancel' });
        finish();
        return;
      }
      try {
        await applyRetrySideEffects(request, decision, { isCurrent });
        if (!isCurrent()) return;
        resolve({ action: 'retry', feedback: decision.userMessage });
      } catch {
        if (isCurrent()) resolve({ action: 'cancel' });
      } finally {
        finish();
      }
    })();
  });
}

async function requestUserQuestionInteraction(
  payload: ProgressEventPayloads['showUserQuestion'],
  context: CliContext,
  host: CliRuntimeHost,
): Promise<{
  submitted: boolean;
  answers?: ApprovalDecision['userQuestionAnswers'];
  feedback?: string;
}> {
  if (!approvalPromptAllowed(context)) {
    return {
      submitted: false,
      feedback: humanInputDenialFeedback(
        context,
        'User question requires human input; yolo mode cannot synthesize an answer.',
      ),
    };
  }

  const decision = await enqueueTuiApproval(
    { kind: 'userQuestion', payload },
    host,
  );
  markIfRejected(context, decision);
  return decision.accepted && decision.userQuestionAnswers
    ? { submitted: true, answers: decision.userQuestionAnswers }
    : {
        submitted: false,
        feedback: decision.userMessage || 'User question skipped by user.',
      };
}

async function openExternalInquiryInteraction(
  payload: ProgressEventPayloads['showExternalInquiry'],
  context: CliContext,
  host: CliRuntimeHost,
): Promise<{ threadId: string }> {
  handleExternalInquiry(payload, context, host);
  return { threadId: payload.threadId };
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

async function applyRetrySideEffects(
  payload: Pick<ProgressEventPayloads['showRetryRequest'], 'streamId'>,
  decision: ApprovalDecision,
  options: { isCurrent?: () => boolean } = {},
): Promise<void> {
  const isCurrent = () => options.isCurrent?.() ?? true;
  if (!isCurrent()) return;
  if (decision.apiMode) {
    await setCliApiMode(decision.apiMode);
    if (!isCurrent()) return;
    patchSessionMeta({ apiMode: decision.apiMode });
  }
  if (decision.disableChatGptSubscription) {
    await setCliCodexSubscription(false);
    if (!isCurrent()) return;
  }
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
