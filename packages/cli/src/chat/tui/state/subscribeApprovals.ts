// TUI implementation of the session-owned HostInteractions approval port.
//
// Approval requests are routed through the typed queue (-> ApprovalModal ->
// user). When the modal resolves, the interaction promise resolves with the
// same host-facing result shape.
//
// Bash and edit policy is honored at the shared tool boundary before this
// presentation adapter is called. Plans, proposals, retries, and human-input
// requests retain their focused CLI decisions here.
//
// Tool-edit is part of this port because it returns a typed
// Promise<ToolEditApprovalResult>, not a fire-and-forget event.

import PQueue from 'p-queue';

import {
  defaultSession,
  matchesCancelSelector,
  type BashSettlement,
  type HostApprovalBypassStateUpdate,
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
} from '@agent/runtime';
import { getCliApiMode, setCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  toApprovalSettlement,
  toToolEditResult,
} from '@cli/runtime/approvalAdapter';
import {
  classifyCliRetryAction,
  isCliApiSwitchableRetry,
} from '@cli/runtime/approval/approvalPrompts';
import {
  denyExternalInquiryIfNoHumanInput,
  settleExecutable,
  settleHumanInputDenial,
  settleRetry,
} from '@cli/runtime/approval/settleApprovals';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { USER_QUESTION_SKIPPED_FEEDBACK } from '@cli/runtime/userQuestionAnswer';
import { missingApiKeyRetryMessage } from '@cli/tui/ui/retryCopy';
import { warn as logWarning } from '@logger/logUtils';
import {
  apiKeyExistsUncached,
  hasUsableApiKey,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import { codingPlanSubscriptionRuntimes } from '@model/codingPlanSubscriptions';
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
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import { patchSessionMeta, patchStream } from './cliState';
import {
  refreshSubscriptionPreferenceViews,
  setCliCodingPlanSubscription,
  setCliCodexSubscription,
} from './codexSubscription';
import {
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
function maybeAutoSwitchRetry(
  payload: TuiRetryRequest,
): ApprovalDecision | undefined {
  // Only relay-exhaustion retries auto-switch; ChatGPT-subscription and
  // coding-plan limits always require an explicit decision (see
  // classifyCliRetryAction for the canonical precedence).
  if (classifyCliRetryAction(payload) !== 'switch-to-personal') {
    return undefined;
  }

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
      const decision = await decidePresentedApproval('toolEdit', request);
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
      return requestBashInteraction(request);
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
async function decidePresentedApproval<
  K extends 'bash' | 'toolEdit' | 'planApproval' | 'proposal',
  P,
>(kind: K, payload: P): Promise<ApprovalDecision> {
  try {
    return await enqueueTuiApproval({ kind, payload } as Extract<
      ApprovalPayload,
      { kind: K }
    >);
  } catch {
    return {
      accepted: false,
      userMessage: 'CLI approval prompt failed.',
    };
  }
}

async function decideWithPolicy<K extends 'planApproval' | 'proposal', P>(
  context: CliContext,
  kind: K,
  payload: P,
): Promise<ApprovalDecision> {
  const policy = settleExecutable(context);
  return policy ?? decidePresentedApproval(kind, payload);
}

async function requestBashInteraction(
  request: HostBashApprovalRequest,
): Promise<BashSettlement> {
  const payload = prepareBashApprovalPrompt(request);
  const decision = await decidePresentedApproval('bash', payload);
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
 * retry the same host owned for the stream (its pre-modal lookup, its modal, or
 * the credential switch it had already started), and holding it until
 * `release` means a later cancel reaches the commit as well. Another host may
 * temporarily overlap during attachment handoff, so its reservation remains
 * isolated. Nothing here re-checks whether the request is still current — a
 * settled entry ignores `present` and `settle`, and its abort signal stops the
 * work in flight.
 */
async function requestRetryInteraction(
  request: HostRetryRequest,
  context: CliContext,
  attachment: { readonly owner: object; readonly commitQueue: PQueue },
  options: HostRetryInteractionOptions | undefined,
): Promise<RetryResult> {
  clearRetryApprovalsForStream(request.streamId, attachment.owner);
  const reservation = reserveApproval(
    { kind: 'retry', payload: request },
    { onPresent: announceApproval, owner: attachment.owner },
  );
  // Written before any path that can produce a credential-changing decision:
  // only the modal and the auto-switch produce one, and both run after this.
  let promptRequest: TuiRetryRequest = request;
  const retryDecision: { source: 'human' | 'automatic' } = {
    source: 'human',
  };

  const immediate = settleRetry(request, context);
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
        autoSwitch = maybeAutoSwitchRetry(promptRequest);
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
        retryDecision.source = 'automatic';
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
      if (immediate) {
        return { action: 'deny', reason: decision.userMessage };
      }
      return { action: 'cancel' };
    }
    if (
      decision.apiMode !== undefined ||
      decision.disableChatGptSubscription === true ||
      decision.disableCodingPlan !== undefined
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
    return {
      action: 'retry',
      feedback: decision.userMessage,
      ...(retryDecision.source === 'automatic'
        ? { decisionSource: retryDecision.source }
        : {}),
    };
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
  const denial = settleHumanInputDenial(context);
  if (denial != null) {
    return { action: 'reject', feedback: denial.userMessage };
  }

  const decision = await enqueueTuiApproval({ kind: 'userQuestion', payload });
  return decision.accepted && decision.userQuestionAnswers
    ? { action: 'submit', answers: decision.userQuestionAnswers }
    : {
        action: 'skip',
        feedback: decision.userMessage || USER_QUESTION_SKIPPED_FEEDBACK,
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
  notify('approvalNeeded');
}

function setTuiApprovalBypassState({
  streamId,
  kind,
  bypassActive,
}: HostApprovalBypassStateUpdate): void {
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

/** Undo one access-settings write that a failed retry had already applied.
 *
 *  Returns the contextualized failure instead of throwing, so a partially
 *  applied switch can report every setting it could not put back rather than
 *  losing all but the first. `restoredInMemory` separates "the value is back
 *  but the write may not have persisted" from "the value is still the one the
 *  user never asked for", because only the latter needs re-doing by hand.
 *
 *  Callers keep their own "did this write happen" guard rather than passing it
 *  in, so a skipped attempt costs no await — see the call site. */
async function attemptRollback({
  restore,
  restoredInMemory,
  memoryRestoredContext,
  restoreFailedContext,
}: {
  /** Restore the previous value and verify it took effect. */
  readonly restore: () => Promise<void>;
  readonly restoredInMemory: () => boolean;
  readonly memoryRestoredContext: string;
  readonly restoreFailedContext: string;
}): Promise<Error | undefined> {
  try {
    await restore();
    return undefined;
  } catch (rollbackError) {
    const persistenceContext = restoredInMemory()
      ? memoryRestoredContext
      : restoreFailedContext;
    return new Error(
      `${persistenceContext}: ${toErrorMessage(rollbackError)}`,
      { cause: rollbackError },
    );
  }
}

/**
 * Per-setting rollback config for {@link switchRetryToPersonalCredentials}.
 * `writeStarted` / `needsRollback` gate each setting; `restore` re-applies the
 * previous value and verifies it took effect (throwing when it did not).
 */
interface RetrySettingRollbackConfig {
  /** Whether this attempt's write started (its per-setting flag). */
  readonly writeStarted: boolean;
  /** Whether the current value is still the one the failed attempt left behind. */
  readonly needsRollback: () => boolean;
  /** Restore the previous value and verify it took effect. */
  readonly restore: () => Promise<void>;
  readonly restoredInMemory: () => boolean;
  readonly memoryRestoredContext: string;
  readonly restoreFailedContext: string;
}

/**
 * Roll back every setting whose failed write left an unwelcome value, in
 * config order. A setting whose write never started, or whose value is already
 * the previous one, is skipped WITHOUT an await: this runs while the commit
 * queue still holds its slot, and the extra turns let a newer queued switch
 * commit ahead of the restores below.
 */
async function rollbackChangedSettings(
  configs: readonly RetrySettingRollbackConfig[],
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const config of configs) {
    if (!config.writeStarted || !config.needsRollback()) continue;
    const failure = await attemptRollback({
      restore: config.restore,
      restoredInMemory: config.restoredInMemory,
      memoryRestoredContext: config.memoryRestoredContext,
      restoreFailedContext: config.restoreFailedContext,
    });
    if (failure) failures.push(failure);
  }
  return failures;
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
        const previousCodingPlans = new Map(
          codingPlanSubscriptionRuntimes.map((runtime) => [
            runtime.descriptor.id,
            runtime.getEnabled(),
          ]),
        );
        let apiModeWriteStarted = false;
        let subscriptionWriteStarted = false;
        const codingPlanWrites = new Set<
          (typeof codingPlanSubscriptionRuntimes)[number]['descriptor']['id']
        >();
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
          const codingPlanId = decision.disableCodingPlan;
          if (codingPlanId) {
            codingPlanWrites.add(codingPlanId);
            await runRetryTask(
              () => setCliCodingPlanSubscription(codingPlanId, false),
              signal,
            );
            signal.throwIfAborted();
          }
          if (decision.apiMode) patchSessionMeta({ apiMode: decision.apiMode });
          return;
        } catch (error) {
          // Each config is evaluated after the previous restore resolved, so a
          // rollback sees the state its predecessor left behind. Skipped
          // attempts must not await: this runs while the commit queue still
          // holds its slot, and the extra turns let a newer queued switch
          // commit ahead of the restores below. OpenRouter is restored after
          // the mode, because restoring included access clears the OpenRouter
          // toggle: a switch the user never got would otherwise leave their
          // routing preference silently off.
          let openRouterToPreserve = previousOpenRouter;
          const rollbackFailures = await rollbackChangedSettings([
            {
              writeStarted: subscriptionWriteStarted,
              needsRollback: () => !isPreferCodexSubscription(),
              restore: async () => {
                const update = await setCliCodexSubscription(
                  previousSubscriptionPreference,
                );
                if (update.effective !== previousSubscriptionPreference) {
                  throw new Error(
                    `ChatGPT subscription preference remained ${String(update.effective)}.`,
                  );
                }
              },
              restoredInMemory: () =>
                isPreferCodexSubscription() === previousSubscriptionPreference,
              memoryRestoredContext:
                'The previous ChatGPT subscription preference appears restored in memory, but persistence could not be confirmed',
              restoreFailedContext:
                'Could not restore the ChatGPT subscription preference',
            },
            ...codingPlanSubscriptionRuntimes.map((runtime) => {
              const id = runtime.descriptor.id;
              const previous = previousCodingPlans.get(id) ?? false;
              return {
                writeStarted: codingPlanWrites.has(id),
                needsRollback: () => runtime.getEnabled() !== previous,
                restore: async () => {
                  await runtime.restoreEnabled(previous);
                  refreshSubscriptionPreferenceViews();
                  if (runtime.getEnabled() !== previous) {
                    throw new Error(
                      `${runtime.descriptor.displayName} remained ${String(runtime.getEnabled())}.`,
                    );
                  }
                },
                restoredInMemory: () => runtime.getEnabled() === previous,
                memoryRestoredContext: `The previous ${runtime.descriptor.displayName} setting appears restored in memory, but persistence could not be confirmed`,
                restoreFailedContext: `Could not restore the ${runtime.descriptor.displayName} setting`,
              };
            }),
            {
              writeStarted: apiModeWriteStarted,
              needsRollback: () => getCliApiMode() === decision.apiMode,
              restore: async () => {
                // A newer OpenRouter choice may have landed after this retry
                // changed modes. Restoring included mode clears that choice,
                // so carry its current value into the final route restore.
                openRouterToPreserve = cliOpenRouterEnabled();
                await setCliApiMode(previousApiMode);
                if (getCliApiMode() !== previousApiMode) {
                  throw new Error(`API mode remained ${getCliApiMode()}.`);
                }
              },
              restoredInMemory: () => getCliApiMode() === previousApiMode,
              memoryRestoredContext:
                'The previous API mode appears restored in memory, but persistence could not be confirmed',
              restoreFailedContext: 'Could not restore API mode',
            },
            {
              writeStarted: apiModeWriteStarted,
              needsRollback: () =>
                openRouterToPreserve && !cliOpenRouterEnabled(),
              restore: async () => {
                await platform().globalState.update(
                  GlobalStateKey.USE_OPENROUTER,
                  true,
                );
                if (!cliOpenRouterEnabled()) {
                  throw new Error('OpenRouter routing remained disabled.');
                }
              },
              restoredInMemory: () => cliOpenRouterEnabled(),
              memoryRestoredContext:
                'The previous OpenRouter routing preference appears restored in memory, but persistence could not be confirmed',
              restoreFailedContext: 'Could not restore OpenRouter routing',
            },
          ]);
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
