// TUI implementation of the session-owned HostInteractions approval port.
//
// Approval requests are routed through the typed queue (-> ApprovalModal ->
// user) instead of the legacy stderr prompt. When the modal resolves, the
// interaction promise resolves with the same host-facing result shape.
//
// Policy is honored *before* the modal is shown — `immediateDecision` runs
// first so `--approval-policy yolo` auto-approves without a modal, and
// `never` auto-rejects with `denyMessage(...)`. Only `ask` (or interactive
// non-print) reaches the queue.
//
// Tool-edit is part of this port because it returns a typed
// Promise<ToolEditApprovalResult>, not a fire-and-forget event.

import { nanoid } from 'nanoid';
import pDefer from 'p-defer';
import PQueue from 'p-queue';
import pTimeout from 'p-timeout';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  matchesCancelSelector,
  type HostBashApprovalRequest,
  type HostBashApprovalResult,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractions,
  type HostRetryInteractionOptions,
  type HostRetryRequest,
  type HostUserQuestionRequest,
  type HostUserQuestionResult,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
} from '@agent/runtime/HostInteractions';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import { isPreferCodexSubscription } from '@auth/codex';
import { getCliApiMode, setCliApiMode } from '@cli/runtime/apiAccessMode';
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
import {
  apiKeyExistsUncached,
  hasUsableApiKey,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import { platform } from '@platform/platform';
import { isUpstreamCreditDepletedError } from '@shared/schemas';
import {
  setBashApprovalSessionBypass,
  setDelegatedWorkApprovalBypasses,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import { patchSessionMeta, patchStream } from './cliState';
import { setCliCodexSubscription } from './codexSubscription';
import {
  type ApprovalBypassKind,
  approveQueuedDelegatedWorkForStream,
  approvalPayloadStreamId,
  clearApprovalsWhere,
  clearRetryApprovalsForStream,
  enqueueApproval,
  onApprovalsCleared,
  type ApprovalDecision,
  type ApprovalPayload,
  type TuiRetryRequest,
} from './approvalQueue';
import { missingApiKeyRetryMessage } from '../ui/retryCopy';

// =========================================================================
// Retry auto-switch: skip the modal when a usable personal key exists
// =========================================================================

/**
 * When a retry is triggered by relay exhaustion and the stored personal key is
 * not the broken credential, switch to personal keys and retry without showing
 * the modal. ChatGPT-subscription limits always require an explicit decision:
 * changing credential ownership must not hide the quota warning or silently
 * spend API-key quota.
 *
 * Returns the auto-switch decision, or `undefined` when the modal is needed
 * (no usable key stored, direct-key failure, or unknown provider).
 */
async function maybeAutoSwitchRetry(
  payload: TuiRetryRequest,
): Promise<ApprovalDecision | undefined> {
  if (!isCliApiSwitchableRetry(payload)) return undefined;
  if (isCliChatGptSubscriptionRetry(payload)) return undefined;

  const details = payload.errorDetails;
  // Upstream credit depletion means the stored direct key IS the broken
  // credential — the user must provide a changed key, so we cannot
  // auto-switch to the stored value.
  if (isUpstreamCreditDepletedError(details)) return undefined;

  if (payload.personalApiKeyAvailable !== true) return undefined;

  return {
    accepted: true,
    apiMode: 'personal',
  };
}

/**
 * Create the typed approval pipeline for the active TUI session.
 */
export function createTuiHostInteractions(
  host: CliRuntimeHost,
  context: CliContext,
): HostInteractions {
  const retryRoutes = new Map<string, ActiveRetryRoute>();
  const disposeApprovalClearListener = onApprovalsCleared(() => {
    invalidateRetryRoutes(retryRoutes, { cancel: true });
  });

  return {
    async requestToolEditApproval(request) {
      let decision: ApprovalDecision | undefined = immediateDecision(context);
      if (!decision) {
        decision = await enqueueTuiApproval({
          kind: 'toolEdit',
          payload: request,
        });
        markIfRejected(context, decision);
      }
      if (
        decision.accepted &&
        decision.bypass === 'toolEdit' &&
        request.streamId
      ) {
        setToolEditApprovalSessionBypass(request.streamId, true, host);
        setTuiApprovalBypassState({
          streamId: request.streamId,
          kind: 'toolEdit',
          bypassActive: true,
        });
      }
      return decision.accepted
        ? { accepted: true, appliedContent: request.proposedContent }
        : { accepted: false, userMessage: decision.userMessage };
    },
    requestBashApproval(request, options) {
      const requestId = `bash-${nanoid()}`;
      return withInteractionTimeout(
        () => requestBashInteraction(request, context, host, requestId),
        options,
        {
          accepted: false,
          userMessage: 'Approval request timed out.',
          timedOut: true,
        },
        () =>
          clearApprovalsWhere(
            (payload) =>
              payload.kind === 'bash' &&
              payload.payload.requestId === requestId,
            NEUTRAL_TIMEOUT_DECISION,
          ),
      );
    },
    requestPlanApproval(request, options) {
      return withInteractionTimeout(
        () => requestPlanInteraction(request, context),
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
        () => requestProposalInteraction(request, context, host),
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
        () => requestRetryInteraction(request, context, retryRoutes, options),
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
    askUserQuestion(request, options) {
      return withInteractionTimeout(
        () => requestUserQuestionInteraction(request, context),
        options,
        { submitted: false, feedback: 'Approval request timed out.' },
        () =>
          clearApprovalsWhere(
            (payload) =>
              payload.kind === 'userQuestion' &&
              payload.payload.requestId === request.requestId,
            NEUTRAL_TIMEOUT_DECISION,
          ),
      );
    },
    openExternalInquiry(request) {
      return openExternalInquiryInteraction(request, context);
    },
    setApprovalBypassState: setTuiApprovalBypassState,
    cancel(selector: HostInteractionCancelSelector = {}) {
      // Retry routes live outside the modal queue (the pre-queue auto-switch
      // lookup), so a retry-kind or unfiltered cancel must settle them too —
      // this is what the coordinator layer's clearAll did before the fold.
      if (selector.kind === undefined || selector.kind === 'retry') {
        if (typeof selector.streamId === 'string') {
          cancelRetryRoute(retryRoutes, selector.streamId);
        } else if (selector.streamId === undefined) {
          invalidateRetryRoutes(retryRoutes, { cancel: true });
        }
        // streamId === null: retry requests always carry a concrete stream id,
        // so the unscoped sweep has no retry routes to settle.
      }
      clearApprovalsWhere((payload) =>
        matchesCancelSelector(
          { kind: payload.kind, streamId: approvalPayloadStreamId(payload) },
          selector,
        ),
      );
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
  readonly preparationController: AbortController;
  readonly settle?: (result: RetryResult) => void;
}

// API mode and ChatGPT preference are process-wide. Keep their transactional
// switch and rollback indivisible across concurrent stream retry decisions.
const retryCredentialSwitchQueue = new PQueue({ concurrency: 1 });

function prepareRetryClient(
  prepare: NonNullable<HostRetryInteractionOptions['prepareRetry']>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      prepare(signal).then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}

const NEUTRAL_TIMEOUT_DECISION: ApprovalDecision = {
  accepted: true,
  userMessage: 'Approval request timed out.',
};

function validTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/**
 * Race an interaction against `options.timeoutMs`, including any async work
 * the interaction does *before* it reaches the modal queue (e.g. the
 * auto-switch retry route's keychain lookup in `beforeQueue`). `start` is a
 * thunk rather than an already-created Promise so the timer is armed before
 * that work begins — a hanging pre-queue lookup still times out on schedule
 * instead of extending the interaction past the intended bound.
 */
function withInteractionTimeout<T>(
  start: () => Promise<T>,
  options: HostInteractionOptions | undefined,
  timeoutResult: T,
  onTimeout: () => void,
): Promise<T> {
  const timeoutMs = validTimeoutMs(options?.timeoutMs);
  if (timeoutMs == null) return start();

  const interaction = pDefer<T>();
  const timedInteraction = pTimeout(interaction.promise, {
    milliseconds: timeoutMs,
    fallback: () => {
      onTimeout();
      return timeoutResult;
    },
  });
  try {
    start().then(interaction.resolve, interaction.reject);
  } catch (error) {
    interaction.reject(error);
  }
  return timedInteraction;
}

function isActiveRetryRoute(
  retryRoutes: Map<string, ActiveRetryRoute>,
  streamId: string,
  routeId: symbol,
): boolean {
  return retryRoutes.get(streamId)?.routeId === routeId;
}

function cancelRetryRoute(
  retryRoutes: Map<string, ActiveRetryRoute>,
  streamId: string,
): void {
  settleRetryRoute(retryRoutes, streamId, { action: 'cancel' });
}

function settleRetryRoute(
  retryRoutes: Map<string, ActiveRetryRoute>,
  streamId: string,
  result: RetryResult,
): void {
  const route = retryRoutes.get(streamId);
  if (!route) return;
  retryRoutes.delete(streamId);
  route.preparationController.abort(new Error('Retry request was replaced.'));
  route.settle?.(result);
}

function invalidateRetryRoutes(
  retryRoutes: Map<string, ActiveRetryRoute>,
  options: { cancel: boolean },
): void {
  const streamIds = [...retryRoutes.keys()];
  for (const streamId of streamIds) {
    if (options.cancel) {
      cancelRetryRoute(retryRoutes, streamId);
    } else {
      retryRoutes.delete(streamId);
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
  kind: K,
  payload: P,
  options: RouteWithPolicyOptions<P> = {},
): Promise<ApprovalDecision> {
  const policy =
    kind === 'retry'
      ? immediateDecisionForApproval(
          'showRetryRequest',
          payload as RuntimeInteractionEventPayloads['showRetryRequest'],
          context,
        )
      : immediateDecision(context);
  if (policy) return policy;

  return decideAfterImmediatePolicy(context, kind, payload, options);
}

async function decideAfterImmediatePolicy<
  K extends 'bash' | 'plan' | 'proposal' | 'retry',
  P,
>(
  context: CliContext,
  kind: K,
  payload: P,
  options: RouteWithPolicyOptions<P> = {},
): Promise<ApprovalDecision> {
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
    const decision = await enqueueTuiApproval(queuePayload);
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
  requestId: string,
): Promise<HostBashApprovalResult> {
  const payload: RuntimeInteractionEventPayloads['showBashPermission'] = {
    requestId,
    command: request.command,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    allowBypass: true,
    streamId: request.streamId ?? '',
  };
  const decision = await decideWithPolicy(context, 'bash', payload);
  if (decision.accepted && decision.bypass === 'bash' && request.streamId) {
    setBashApprovalSessionBypass(request.streamId, true, host);
    setTuiApprovalBypassState({
      streamId: request.streamId,
      kind: 'bash',
      bypassActive: true,
    });
  }
  return {
    accepted: decision.accepted,
    userMessage: feedbackOnReject(decision),
  };
}

async function requestPlanInteraction(
  request: RuntimeInteractionEventPayloads['showPlanApproval'],
  context: CliContext,
): Promise<PlanApprovalResult> {
  const decision = await decideWithPolicy(context, 'plan', request);
  const feedback = feedbackOnReject(decision);
  return decision.accepted
    ? { action: decision.planAction ?? 'approve' }
    : { action: 'reject', ...(feedback ? { feedback } : {}) };
}

async function requestProposalInteraction(
  request: RuntimeInteractionEventPayloads['showAgentProposal'],
  context: CliContext,
  host: CliRuntimeHost,
): Promise<ProposalResult> {
  const decision = await decideWithPolicy(context, 'proposal', request);
  if (
    decision.accepted &&
    decision.bypass === 'superYolo' &&
    request.streamId
  ) {
    setDelegatedWorkApprovalBypasses(request.streamId, true, host);
    for (const kind of ['superYolo', 'toolEdit', 'bash'] as const) {
      setTuiApprovalBypassState({
        streamId: request.streamId,
        kind,
        bypassActive: true,
      });
    }
    approveQueuedDelegatedWorkForStream(request.streamId);
  }
  const feedback = feedbackOnReject(decision);
  return decision.accepted
    ? { action: 'approve' }
    : { action: 'reject', ...(feedback ? { feedback } : {}) };
}

async function requestRetryInteraction(
  request: HostRetryRequest,
  context: CliContext,
  retryRoutes: Map<string, ActiveRetryRoute>,
  options: HostRetryInteractionOptions | undefined,
): Promise<RetryResult> {
  cancelRetryRoute(retryRoutes, request.streamId);
  const routeId = Symbol(request.streamId);
  const preparationController = new AbortController();
  clearRetryApprovalsForStream(request.streamId);

  return await new Promise<RetryResult>((resolve) => {
    retryRoutes.set(request.streamId, {
      routeId,
      preparationController,
      settle: resolve,
    });
    const isCurrent = () =>
      isActiveRetryRoute(retryRoutes, request.streamId, routeId);
    const finish = () => {
      if (isCurrent()) retryRoutes.delete(request.streamId);
    };

    void (async () => {
      const immediate: ApprovalDecision | undefined =
        immediateDecisionForApproval('showRetryRequest', request, context);
      let promptRequest: TuiRetryRequest = request;
      if (!immediate && isCliApiSwitchableRetry(request)) {
        const requestedProvider = request.errorDetails?.provider;
        const provider =
          requestedProvider && isApiProvider(requestedProvider)
            ? requestedProvider
            : undefined;
        let personalApiKeyAvailable = false;
        let missingPersonalApiKeyMessage = missingApiKeyRetryMessage(provider);
        if (provider) {
          try {
            personalApiKeyAvailable = await hasUsableApiKey(
              platform().secrets,
              provider,
            );
          } catch {
            // A keychain failure must not permit an automatic credential switch.
            missingPersonalApiKeyMessage = missingApiKeyRetryMessage(
              provider,
              'unavailable',
            );
          }
        }
        promptRequest = {
          ...request,
          personalApiKeyAvailable,
          missingPersonalApiKeyMessage,
        };
      }
      if (!isCurrent()) return;
      const decision =
        immediate ??
        (await decideAfterImmediatePolicy(context, 'retry', promptRequest, {
          beforeQueue: maybeAutoSwitchRetry,
          isCurrent,
        }));
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
        const changesCredentialRoute =
          decision.apiMode !== undefined ||
          decision.disableChatGptSubscription === true;
        if (changesCredentialRoute) {
          await retryCredentialSwitchQueue.add(() =>
            applyRetrySideEffects(decision, promptRequest, {
              isCurrent,
              prepareRetry: options?.prepareRetry,
              preparationSignal: preparationController.signal,
            }),
          );
        } else if (options?.prepareRetry) {
          const prepareRetry = options.prepareRetry;
          // Client construction is a read of process-wide credential state.
          // Linearize it with credential writes so it cannot observe a route
          // that a concurrent switch later rolls back.
          await retryCredentialSwitchQueue.add(async () => {
            if (isCurrent()) {
              await prepareRetryClient(
                prepareRetry,
                preparationController.signal,
              );
            }
          });
        }
        if (!isCurrent()) return;
        resolve({ action: 'retry', feedback: decision.userMessage });
      } catch (error) {
        if (isCurrent()) {
          resolve({ action: 'deny', reason: toErrorMessage(error) });
        }
      } finally {
        finish();
      }
    })();
  });
}

async function requestUserQuestionInteraction(
  payload: HostUserQuestionRequest,
  context: CliContext,
): Promise<HostUserQuestionResult> {
  if (!approvalPromptAllowed(context)) {
    return {
      submitted: false,
      feedback: humanInputDenialFeedback(
        context,
        'User question requires human input; yolo mode cannot synthesize an answer.',
      ),
    };
  }

  const decision = await enqueueTuiApproval({ kind: 'userQuestion', payload });
  markIfRejected(context, decision);
  return decision.accepted && decision.userQuestionAnswers
    ? { submitted: true, answers: decision.userQuestionAnswers }
    : {
        submitted: false,
        feedback: decision.userMessage || 'User question skipped by user.',
      };
}

async function openExternalInquiryInteraction(
  payload: RuntimeInteractionEventPayloads['showExternalInquiry'],
  context: CliContext,
): Promise<{ threadId: string }> {
  handleExternalInquiry(payload, context);
  return { threadId: payload.threadId };
}

export function enqueueTuiApproval(
  payload: ApprovalPayload,
): Promise<ApprovalDecision> {
  return enqueueApproval(payload, {
    onPresent: () => {
      const streamId = approvalPayloadStreamId(payload);
      if (streamId) {
        defaultSession().events.emit({
          scope: 'session',
          event: {
            type: 'setActiveStream',
            payload: { streamId },
          },
        });
      }
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

function setTuiApprovalBypassState({
  streamId,
  kind,
  bypassActive,
}: {
  readonly streamId: string;
  readonly kind: ApprovalBypassKind;
  readonly bypassActive: boolean;
}): void {
  patchStream(streamId, (s) => ({
    ...s,
    bypass: { ...s.bypass, [kind]: bypassActive },
  }));
}

async function applyRetrySideEffects(
  decision: ApprovalDecision,
  request: TuiRetryRequest,
  options: {
    isCurrent?: () => boolean;
    prepareRetry?: HostRetryInteractionOptions['prepareRetry'];
    preparationSignal?: AbortSignal;
  } = {},
): Promise<void> {
  const isCurrent = () => options.isCurrent?.() ?? true;
  if (!isCurrent()) return;

  const requestedProvider = request.errorDetails?.provider;
  if (!requestedProvider || !isApiProvider(requestedProvider)) {
    throw new Error(
      'The failed API provider could not be identified, so TeXRA did not change access settings.',
    );
  }
  const missingKeyMessage =
    request.missingPersonalApiKeyMessage ??
    missingApiKeyRetryMessage(requestedProvider);
  const validateCurrentKey = async (): Promise<void> => {
    const keyExists = await apiKeyExistsUncached(
      platform().secrets,
      requestedProvider,
    );
    if (!isCurrent()) throw new Error('Retry request was replaced.');
    if (!keyExists) throw new Error(missingKeyMessage);
    // The presentation check is deliberately cached. Drop that cache only
    // after the uncached commit check so getClient() must read the current key.
    invalidateApiKeyCache();
  };

  await validateCurrentKey();

  const previousApiMode = getCliApiMode();
  const previousSubscriptionPreference = isPreferCodexSubscription();
  let apiModeWriteStarted = false;
  let subscriptionWriteStarted = false;
  try {
    if (decision.apiMode) {
      apiModeWriteStarted = true;
      await setCliApiMode(decision.apiMode);
      if (!isCurrent()) throw new Error('Retry request was replaced.');
    }
    if (decision.disableChatGptSubscription) {
      subscriptionWriteStarted = true;
      const update = await setCliCodexSubscription(false);
      if (update.effective) {
        throw new Error(
          'ChatGPT subscription remains enabled by a more specific setting.',
        );
      }
      if (!isCurrent()) throw new Error('Retry request was replaced.');
    }
    if (!options.prepareRetry) {
      throw new Error('The model client cannot be refreshed for this retry.');
    }
    // Settings select the route used by getClient(), so construct only after
    // they change. Revalidate once more in case the key changed during either
    // persisted setting write, then invalidate before construction.
    await validateCurrentKey();
    await prepareRetryClient(
      options.prepareRetry,
      options.preparationSignal ?? new AbortController().signal,
    );
    // Commit invariant: no retry proceeds unless its final settings and live
    // client agree. Publish the session-visible mode only after construction,
    // avoiding a transient personal-mode UI state when preparation rolls back.
    if (decision.apiMode) patchSessionMeta({ apiMode: decision.apiMode });
  } catch (error) {
    const rollbackFailures: Error[] = [];
    if (subscriptionWriteStarted && !isPreferCodexSubscription()) {
      try {
        const update = await setCliCodexSubscription(
          previousSubscriptionPreference,
        );
        if (update.effective !== previousSubscriptionPreference) {
          throw new Error(
            `ChatGPT subscription preference remained ${String(update.effective)}.`,
          );
        }
      } catch (rollbackError) {
        const persistenceContext =
          isPreferCodexSubscription() === previousSubscriptionPreference
            ? 'The previous ChatGPT subscription preference appears restored in memory, but persistence could not be confirmed'
            : 'Could not restore the ChatGPT subscription preference';
        rollbackFailures.push(
          new Error(`${persistenceContext}: ${toErrorMessage(rollbackError)}`, {
            cause: rollbackError,
          }),
        );
      }
    }
    if (apiModeWriteStarted && getCliApiMode() === decision.apiMode) {
      try {
        await setCliApiMode(previousApiMode);
        if (getCliApiMode() !== previousApiMode) {
          throw new Error(`API mode remained ${getCliApiMode()}.`);
        }
      } catch (rollbackError) {
        const persistenceContext =
          getCliApiMode() === previousApiMode
            ? 'The previous API mode appears restored in memory, but persistence could not be confirmed'
            : 'Could not restore API mode';
        rollbackFailures.push(
          new Error(`${persistenceContext}: ${toErrorMessage(rollbackError)}`, {
            cause: rollbackError,
          }),
        );
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `${toErrorMessage(error)} Previous access settings could not be fully restored: ${rollbackFailures.map(toErrorMessage).join(' ')}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function handleExternalInquiry(
  payload: RuntimeInteractionEventPayloads['showExternalInquiry'],
  context: CliContext,
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
  void enqueueTuiApproval({ kind: 'externalInquiry', payload }).then(
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
