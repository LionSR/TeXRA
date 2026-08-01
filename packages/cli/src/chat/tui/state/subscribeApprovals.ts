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

import PQueue from 'p-queue';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  matchesCancelSelector,
  type BashSettlement,
  type HostBashApprovalRequest,
  type HostInteractionCancelSelector,
  type HostInteractions,
  type HostRetryInteractionOptions,
  type HostRetryRequest,
  type HostUserQuestionRequest,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import { getCliApiMode, setCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  askUserQuestionDenial,
  immediateDecision,
  immediateDecisionForApproval,
  isCliApiSwitchableRetry,
  isCliChatGptSubscriptionRetry,
  markApprovalDenied,
  toApprovalSettlement,
  toToolEditResult,
} from '@cli/runtime/approvalAdapter';
import { denyExternalInquiryIfNoHumanInput } from '@cli/runtime/approval/humanInputHandlers';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { missingApiKeyRetryMessage } from '@cli/tui/ui/retryCopy';
import { warn as logWarning } from '@logger/logUtils';
import {
  apiKeyExistsUncached,
  hasUsableApiKey,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import { isPreferCodexSubscription } from '@model/codex/codexPreference';
import { platform } from '@platform/platform';
import {
  isUpstreamCreditDepletedError,
  type AgentProposalPermission,
  type ExternalInquiryPermission,
  type PlanApprovalPermission,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  setDelegatedWorkApprovalBypasses,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import {
  prepareBashApprovalPrompt,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import { patchSessionMeta, patchStream } from './cliState';
import { setCliCodexSubscription } from './codexSubscription';
import {
  type ApprovalBypassKind,
  approveQueuedDelegatedWorkForStream,
  approvalPayloadStreamId,
  clearApprovalsForOwner,
  clearApprovalsWhere,
  clearRetryApprovalsForStream,
  enqueueApproval,
  reserveApproval,
  type ApprovalDecision,
  type ApprovalPayload,
  type TuiRetryRequest,
} from './approvalQueue';

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
  // The two persisted access fields commit as one choice within this TUI
  // lifetime. Keeping the queue session-owned prevents stale work leaking
  // across disposed hosts or tests.
  const retryCredentialCommitQueue = new PQueue({ concurrency: 1 });
  // Identity of this attachment in the shared approval queue.
  const interactionOwner = {};

  return {
    emit: (event, payload) => host.emit(event, payload),
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
        setToolEditApprovalSessionBypass(request.streamId, true);
      }
      return toToolEditResult(decision, request.proposedContent);
    },
    requestBashApproval(request) {
      return requestBashInteraction(request, context);
    },
    requestPlanApproval(request) {
      return requestPlanInteraction(request, context);
    },
    requestAgentProposal(request) {
      return requestProposalInteraction(request, context);
    },
    requestRetry(request, options) {
      return requestRetryInteraction(
        request,
        context,
        { owner: interactionOwner, commitQueue: retryCredentialCommitQueue },
        options,
      );
    },
    askUserQuestion(request) {
      return requestUserQuestionInteraction(request, context);
    },
    async openExternalInquiry(request) {
      handleExternalInquiry(request, context);
      return { threadId: request.threadId };
    },
    setApprovalBypassState(update) {
      setTuiApprovalBypassState(update);
      host.emitApprovalBypassState(update);
    },
    cancel(selector: HostInteractionCancelSelector = {}) {
      clearApprovalsWhere((payload) =>
        matchesCancelSelector(
          { kind: payload.kind, streamId: approvalPayloadStreamId(payload) },
          selector,
        ),
      );
    },
    dispose() {
      // Retries are the only requests that carry work bound to this host (the
      // key lookup and the credential commit queue above), so detaching must
      // settle them. Other queued approvals stay decidable at the modal, and a
      // newer host's retries belong to that host's reservations, not these.
      clearApprovalsForOwner(interactionOwner);
    },
  };
}

function runRetryTask<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason ??
          new DOMException('Retry preparation aborted.', 'AbortError'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      start().then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
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

function prepareRetryClient(
  prepare: NonNullable<HostRetryInteractionOptions['prepareRetry']>,
  selection: Parameters<
    NonNullable<HostRetryInteractionOptions['prepareRetry']>
  >[0],
  signal: AbortSignal,
): Promise<void> {
  return runRetryTask(() => prepare(selection, signal), signal);
}

// Retry carries its own policy lookup (`showRetryRequest`) and owns a queue
// reservation, so it does not enter through this path.
async function decideWithPolicy<
  K extends 'bash' | 'planApproval' | 'proposal',
  P,
>(context: CliContext, kind: K, payload: P): Promise<ApprovalDecision> {
  const policy = immediateDecision(context);
  if (policy) return policy;

  try {
    const queuePayload = { kind, payload } as Extract<
      ApprovalPayload,
      { kind: K }
    >;
    const decision = await enqueueTuiApproval(queuePayload);
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
): Promise<BashSettlement> {
  const payload = prepareBashApprovalPrompt(request);
  const decision = await decideWithPolicy(context, 'bash', payload);
  if (decision.accepted && decision.bypass === 'bash' && request.streamId) {
    setBashApprovalSessionBypass(request.streamId, true);
  }
  return toApprovalSettlement(decision);
}

async function requestPlanInteraction(
  request: PlanApprovalPermission,
  context: CliContext,
): Promise<PlanApprovalResult> {
  const decision = await decideWithPolicy(context, 'planApproval', request);
  // `approve_and_goal` is a TUI-only plan action; every other outcome is the
  // shared approve/reject settlement.
  if (decision.accepted && decision.planAction) {
    return { action: decision.planAction };
  }
  return toApprovalSettlement(decision);
}

async function requestProposalInteraction(
  request: AgentProposalPermission,
  context: CliContext,
): Promise<ProposalResult> {
  const decision = await decideWithPolicy(context, 'proposal', request);
  if (
    decision.accepted &&
    decision.bypass === 'superYolo' &&
    request.streamId
  ) {
    setDelegatedWorkApprovalBypasses(request.streamId, true);
    approveQueuedDelegatedWorkForStream(request.streamId);
  }
  return toApprovalSettlement(decision);
}

/**
 * The queue entry is this retry's liveness: reserving it replaces whatever
 * retry the stream had (its pre-modal lookup, its modal, or the credential
 * switch it had already started), and holding it until `release` means a later
 * cancel reaches the commit as well. Nothing here re-checks whether the
 * request is still current — a settled entry ignores `present` and `settle`,
 * and its abort signal stops the work in flight.
 */
async function requestRetryInteraction(
  request: HostRetryRequest,
  context: CliContext,
  attachment: { readonly owner: object; readonly commitQueue: PQueue },
  options: HostRetryInteractionOptions | undefined,
): Promise<RetryResult> {
  clearRetryApprovalsForStream(request.streamId);
  const reservation = reserveApproval(
    { kind: 'retry', payload: request },
    { onPresent: announceApproval, owner: attachment.owner },
  );
  // Written before any path that can produce a credential-changing decision:
  // only the modal and the auto-switch produce one, and both run after this.
  let promptRequest: TuiRetryRequest = request;

  const immediate = immediateDecisionForApproval(
    'showRetryRequest',
    request,
    context,
  );
  if (immediate) {
    reservation.settle(immediate);
  } else {
    void (async () => {
      let autoSwitch: ApprovalDecision | undefined;
      try {
        if (isCliApiSwitchableRetry(request)) {
          const requestedProvider = request.errorDetails?.provider;
          const provider =
            requestedProvider && isApiProvider(requestedProvider)
              ? requestedProvider
              : undefined;
          let personalApiKeyAvailable = false;
          let missingPersonalApiKeyMessage =
            missingApiKeyRetryMessage(provider);
          if (provider) {
            try {
              personalApiKeyAvailable = await hasUsableApiKey(
                platform().secrets,
                provider,
              );
            } catch {
              // A keychain failure must not permit an automatic credential
              // switch.
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
        autoSwitch = await maybeAutoSwitchRetry(promptRequest);
      } catch (error) {
        // Preparation only decides whether the modal can be skipped, so a
        // failed lookup falls through to the modal instead of denying a retry
        // the user never saw.
        logWarning(
          'cli.tui',
          `The retry request could not be prepared: ${toErrorMessage(error)}`,
        );
      }
      if (autoSwitch) {
        reservation.settle(autoSwitch);
        return;
      }
      try {
        reservation.present({ kind: 'retry', payload: promptRequest });
      } catch (error) {
        logWarning(
          'cli.tui',
          `The retry request could not be shown: ${toErrorMessage(error)}`,
        );
        reservation.settle({
          accepted: false,
          userMessage: toErrorMessage(error),
        });
      }
    })();
  }

  const decision = await reservation.decided;
  try {
    if (!decision.accepted) {
      // A cleared or replaced entry was never denied by a user, so it must not
      // mark the run as approval-denied.
      if (!reservation.signal.aborted) markApprovalDenied(context);
      return { action: 'cancel' };
    }
    if (
      decision.apiMode !== undefined ||
      decision.disableChatGptSubscription === true
    ) {
      await switchRetryToPersonalCredentials(decision, promptRequest, {
        prepareRetry: options?.prepareRetry,
        preparationSignal: reservation.signal,
        commitQueue: attachment.commitQueue,
      });
    } else if (options?.prepareRetry) {
      await prepareRetryClient(
        options.prepareRetry,
        'configured',
        reservation.signal,
      );
    }
    // A cancel landing while the last preparation step was already resolving
    // has no await left to reject, so the entry's own state decides.
    if (reservation.signal.aborted) return { action: 'cancel' };
    return { action: 'retry', feedback: decision.userMessage };
  } catch (error) {
    if (reservation.signal.aborted) return { action: 'cancel' };
    return { action: 'deny', reason: toErrorMessage(error) };
  } finally {
    reservation.release();
  }
}

async function requestUserQuestionInteraction(
  payload: HostUserQuestionRequest,
  context: CliContext,
): Promise<UserQuestionSettlement> {
  const denial = askUserQuestionDenial(context);
  if (denial) return denial;

  const decision = await enqueueTuiApproval({ kind: 'userQuestion', payload });
  markIfRejected(context, decision);
  return decision.accepted && decision.userQuestionAnswers
    ? { action: 'submit', answers: decision.userQuestionAnswers }
    : {
        action: 'skip',
        feedback: decision.userMessage || 'User question skipped by user.',
      };
}

export function enqueueTuiApproval(
  payload: ApprovalPayload,
): Promise<ApprovalDecision> {
  return enqueueApproval(payload, { onPresent: announceApproval });
}

/** Focus the asking stream and ring the terminal when a modal appears. */
function announceApproval(payload: ApprovalPayload): void {
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

function cliOpenRouterEnabled(): boolean {
  return platform().globalState.get<boolean>(
    GlobalStateKey.USE_OPENROUTER,
    false,
  );
}

async function switchRetryToPersonalCredentials(
  decision: ApprovalDecision,
  request: TuiRetryRequest,
  options: {
    prepareRetry?: HostRetryInteractionOptions['prepareRetry'];
    preparationSignal: AbortSignal;
    commitQueue: PQueue;
  },
): Promise<void> {
  const signal = options.preparationSignal;

  const requestedProvider = request.errorDetails?.provider;
  if (!requestedProvider || !isApiProvider(requestedProvider)) {
    throw new Error(
      'The failed API provider could not be identified, so TeXRA did not change access settings.',
    );
  }
  const keyExists = await runRetryTask(
    () => apiKeyExistsUncached(platform().secrets, requestedProvider),
    signal,
  );
  if (!keyExists) {
    throw new Error(
      request.missingPersonalApiKeyMessage ??
        missingApiKeyRetryMessage(requestedProvider),
    );
  }
  // The presentation check is deliberately cached. Drop that cache only after
  // the uncached commit check so getClient() must read the current key.
  invalidateApiKeyCache();

  if (!options.prepareRetry) {
    throw new Error('The model client cannot be refreshed for this retry.');
  }
  await prepareRetryClient(options.prepareRetry, 'personal', signal);

  // Wrapped so a cancel settles this retry immediately instead of waiting for
  // an unrelated stream's commit or rollback to drain first. The task still
  // runs, and stops at the check below.
  await runRetryTask(
    () =>
      options.commitQueue.add(async () => {
        // The task can wait behind another stream's rollback, so the queue may
        // have cancelled this retry since it was scheduled.
        signal.throwIfAborted();
        const previousApiMode = getCliApiMode();
        const previousOpenRouter = cliOpenRouterEnabled();
        const previousSubscriptionPreference = isPreferCodexSubscription();
        let apiModeWriteStarted = false;
        let subscriptionWriteStarted = false;
        try {
          if (decision.apiMode) {
            const apiMode = decision.apiMode;
            apiModeWriteStarted = true;
            await runRetryTask(() => setCliApiMode(apiMode), signal);
            signal.throwIfAborted();
          }
          if (decision.disableChatGptSubscription) {
            subscriptionWriteStarted = true;
            const update = await runRetryTask(
              () => setCliCodexSubscription(false),
              signal,
            );
            if (update.effective) {
              throw new Error(
                'ChatGPT subscription remains enabled by a more specific setting.',
              );
            }
            signal.throwIfAborted();
          }
          if (decision.apiMode) patchSessionMeta({ apiMode: decision.apiMode });
          return;
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
                new Error(
                  `${persistenceContext}: ${toErrorMessage(rollbackError)}`,
                  {
                    cause: rollbackError,
                  },
                ),
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
                new Error(
                  `${persistenceContext}: ${toErrorMessage(rollbackError)}`,
                  {
                    cause: rollbackError,
                  },
                ),
              );
            }
          }
          // After the mode, because restoring included access clears the OpenRouter
          // toggle: a switch the user never got would otherwise leave their routing
          // preference silently off.
          if (
            apiModeWriteStarted &&
            previousOpenRouter &&
            !cliOpenRouterEnabled()
          ) {
            try {
              await platform().globalState.update(
                GlobalStateKey.USE_OPENROUTER,
                true,
              );
              if (!cliOpenRouterEnabled()) {
                throw new Error('OpenRouter routing remained disabled.');
              }
            } catch (rollbackError) {
              const persistenceContext = cliOpenRouterEnabled()
                ? 'The previous OpenRouter routing preference appears restored in memory, but persistence could not be confirmed'
                : 'Could not restore OpenRouter routing';
              rollbackFailures.push(
                new Error(
                  `${persistenceContext}: ${toErrorMessage(rollbackError)}`,
                  {
                    cause: rollbackError,
                  },
                ),
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
      }),
    signal,
  );
}

function handleExternalInquiry(
  payload: ExternalInquiryPermission,
  context: CliContext,
): void {
  const threadId = payload.threadId;
  if (!threadId) return;

  if (denyExternalInquiryIfNoHumanInput(threadId, context)) return;
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
