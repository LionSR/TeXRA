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
  currentSession,
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
import {
  toApprovalSettlement,
  toBashApprovalSettlement,
  toToolEditResult,
} from '@cli/runtime/approvalAdapter';
import {
  classifyCliRetryAction,
  cliRetryApiSwitchDecision,
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
import { subscriptionProvider } from '@controllers/modelAccess/subscriptionProviders';
import { warn as logWarning } from '@logger/logUtils';
import {
  apiKeyExistsUncached,
  hasUsableApiKey,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import {
  codingPlanSubscriptionRuntimes,
  type CodingPlanSubscriptionRuntime,
} from '@model/codingPlanSubscriptions';
import { platform } from '@platform/platform';
import {
  isCodingPlanQuotaRoute,
  type QuotaFallbackRouteId,
} from '@shared/quotaFallbackRoutes';
import {
  type AgentProposalPermission,
  type ExternalInquiryPermission,
  type PlanApprovalPermission,
} from '@shared/schemas';
import { setToolEditApprovalSessionBypass } from '@tools/approval';
import {
  prepareBashApprovalPrompt,
  setBashApprovalSessionBypass,
} from '@tools/approval/bashApproval';
import { prepareToolEditApprovalPrompt } from '@tools/approval/toolEditApproval';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import { generateShortId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { notify } from '../notifications/terminalNotifier';
import { patchStream } from './cliState';
import {
  refreshSubscriptionPreferenceViews,
  setCliCodingPlanSubscription,
  setCliSubscriptionPreference,
} from './subscriptionPreference';
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
  type RetryApprovalPayload,
} from './approvalQueue';

// =========================================================================
// Retry auto-switch: skip the modal when a usable personal key exists
// =========================================================================

/**
 * When a retry is triggered by a coding-plan quota limit
 * and the stored fallback key is not the broken credential, switch to
 * the stored key and retry without showing the modal. This is what lets
 * delegated subagents recover from an exhausted Kimi Code or GLM Coding Plan
 * without a human present. ChatGPT-subscription limits always require an
 * explicit decision: changing credential ownership must not hide the quota
 * warning or silently spend API-key quota. Coding-plan switches relax that
 * for the unattended recovery they exist for, so the user instead gets a
 * terminal notification when a switch disables a plan preference, and a
 * model with no fallback route at all (Kimi Code-exclusive) keeps the modal.
 *
 * Returns the auto-switch decision, or `undefined` when the modal is needed
 * (no usable key stored, direct-key failure, no fallback route, or unknown
 * provider).
 */
function maybeAutoSwitchRetry(
  payload: RetryApprovalPayload,
): ApprovalDecision | undefined {
  const action = classifyCliRetryAction(payload.data);

  // Coding-plan quotas (Kimi Code, GLM Coding Plan) have a fallback route that
  // re-uses an already-stored key, so auto-switch when that key exists.
  // OAuth subscriptions (ChatGPT, Grok) stay explicit: the user must confirm.
  // Kimi Code-exclusive models never reach this branch: the classifier above
  // gates them to 'none', keeping the modal without an API-key switch.
  if (action.startsWith('disable-quota-route:')) {
    const decision = cliRetryApiSwitchDecision(payload.data);
    if (
      decision.disableQuotaRoute === undefined ||
      !isCodingPlanQuotaRoute(decision.disableQuotaRoute)
    ) {
      return undefined;
    }
    if (payload.tui.personalApiKeyAvailable !== true) return undefined;
    return decision;
  }

  return undefined;
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
      const decision = await enqueueDecision({
        kind: 'toolEdit',
        data: prepareToolEditApprovalPrompt(currentSession(), {
          requestId: `approval-${generateShortId()}`,
          request,
          relativePath: WorkspaceFS.relativePath(request.path),
        }),
        tui: {
          originalContent: request.originalContent,
          proposedContent: request.proposedContent,
        },
      });
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
async function enqueueDecision(
  payload: ApprovalPayload,
): Promise<ApprovalDecision> {
  try {
    return await enqueueTuiApproval(payload);
  } catch (error) {
    logWarning(
      'cli.tui',
      `The approval prompt failed: ${toErrorMessage(error)}`,
    );
    return {
      accepted: false,
      rejectionCause: 'CLI approval prompt failed.',
    };
  }
}

async function decideWithPolicy(
  context: CliContext,
  payload: Extract<ApprovalPayload, { kind: 'planApproval' | 'proposal' }>,
): Promise<ApprovalDecision> {
  const policy = settleExecutable(context);
  if (policy && !policy.accepted) {
    return {
      accepted: false,
      rejectionReason: policy.userMessage ?? '',
    };
  }
  return policy ?? enqueueDecision(payload);
}

async function requestBashInteraction(
  request: HostBashApprovalRequest,
): Promise<BashSettlement> {
  const decision = await enqueueDecision({
    kind: 'bash',
    data: prepareBashApprovalPrompt(request),
  });
  if (decision.accepted && decision.bypass === 'bash' && request.streamId) {
    setBashApprovalSessionBypass(request.streamId, true);
  }
  return toBashApprovalSettlement(decision);
}

async function requestPlanInteraction(
  request: PlanApprovalPermission,
  context: CliContext,
): Promise<PlanApprovalResult> {
  const decision = await decideWithPolicy(context, {
    kind: 'planApproval',
    data: request,
  });
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
  const decision = await decideWithPolicy(context, {
    kind: 'proposal',
    data: request,
  });
  if (
    decision.accepted &&
    decision.bypass === 'superYolo' &&
    request.streamId
  ) {
    currentSession().approvals.setDelegatedWorkBypasses(request.streamId, true);
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
    { kind: 'retry', data: request, tui: {} },
    { onPresent: announceApproval, owner: attachment.owner },
  );
  // Written before any path that can produce a credential-changing decision:
  // only the modal and the auto-switch produce one, and both run after this.
  let promptRequest: RetryApprovalPayload = {
    kind: 'retry',
    data: request,
    tui: {},
  };
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
            kind: 'retry',
            data: request,
            tui: { personalApiKeyAvailable, missingPersonalApiKeyMessage },
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
        reservation.present(promptRequest);
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
    if (decision.disableQuotaRoute !== undefined) {
      await switchRetryToPersonalCredentials(decision, promptRequest, {
        prepareRetry: options?.prepareRetry,
        preparationSignal: reservation.signal,
        commitQueue: attachment.commitQueue,
      });
      // Skipping the modal also skips its quota warning, and the switch
      // persists the plan preference as disabled. Announce it only after the
      // switch commits: a preparation failure rolls the preference back, and
      // the user must not be told a switch happened that did not.
      if (
        retryDecision.source === 'automatic' &&
        decision.disableQuotaRoute !== undefined &&
        isCodingPlanQuotaRoute(decision.disableQuotaRoute)
      ) {
        notify('credentialSwitched');
      }
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
    return { action: 'reject', reason: denial.reason };
  }

  const decision = await enqueueTuiApproval({
    kind: 'userQuestion',
    data: payload,
  });
  if (decision.rejectionCause !== undefined) {
    return { action: 'reject', cause: decision.rejectionCause };
  }
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

/**
 * Rollback config for one coding-plan preference, shared by the pre-commit
 * restore (a switch that failed before or during client preparation) and the
 * commit task's rollback (a later access-settings write failed).
 */
function codingPlanRollbackConfig(
  runtime: CodingPlanSubscriptionRuntime,
  previous: boolean,
  writeStarted: boolean,
): RetrySettingRollbackConfig {
  return {
    writeStarted,
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
}

/** Throw `error`, aggregated with any rollback failures it triggered. */
function throwWithRollbackFailures(
  error: unknown,
  rollbackFailures: readonly Error[],
): never {
  if (rollbackFailures.length > 0) {
    throw new AggregateError(
      [error, ...rollbackFailures],
      `${toErrorMessage(error)} Previous access settings could not be fully restored: ${rollbackFailures.map(toErrorMessage).join(' ')}`,
      { cause: error },
    );
  }
  throw error;
}

interface OauthCliPreference {
  readonly label: string;
  readonly isPrefer: () => boolean;
  readonly setPrefer: (
    enabled: boolean,
  ) => Promise<{ readonly effective: boolean }>;
}

function oauthCliPreference(
  id: QuotaFallbackRouteId | undefined,
): OauthCliPreference | undefined {
  if (id !== 'chatgpt' && id !== 'grok') return undefined;
  const provider = subscriptionProvider(id);
  return {
    label: provider.displayName,
    isPrefer: provider.isPreferSubscription,
    setPrefer: (enabled) => setCliSubscriptionPreference(id, enabled),
  };
}

/** Commit the subscription-preference writes for a retry switch.
 *
 *  Runs while the commit queue already holds its slot. On failure it rolls
 *  back everything it wrote (plus the already-disabled coding plan, when one
 *  is supplied) and rethrows; callers then surface the aggregate error.
 */
async function applyRetryCredentialCommit(
  decision: ApprovalDecision,
  signal: AbortSignal,
  codingPlanRollback?: RetrySettingRollbackConfig,
): Promise<void> {
  signal.throwIfAborted();
  const oauth = oauthCliPreference(decision.disableQuotaRoute);
  const previousOauthPreference = oauth?.isPrefer() ?? false;
  let subscriptionWriteStarted = false;
  try {
    if (oauth) {
      subscriptionWriteStarted = true;
      const update = await runRetryTask(() => oauth.setPrefer(false), signal);
      if (update.effective) {
        throw new Error(
          `${oauth.label} subscription remains enabled by a more specific setting.`,
        );
      }
      signal.throwIfAborted();
    }
    return;
  } catch (error) {
    // Each config is evaluated after the previous restore resolved, so a
    // rollback sees the state its predecessor left behind. Skipped attempts
    // must not await: this runs while the commit queue still holds its slot,
    // and the extra turns let a newer queued switch commit ahead of the
    // restores below.
    const rollbackFailures = await rollbackChangedSettings([
      ...(oauth === undefined
        ? []
        : [
            {
              writeStarted: subscriptionWriteStarted,
              needsRollback: () => !oauth.isPrefer(),
              restore: async () => {
                const update = await oauth.setPrefer(previousOauthPreference);
                if (update.effective !== previousOauthPreference) {
                  throw new Error(
                    `${oauth.label} subscription preference remained ${String(update.effective)}.`,
                  );
                }
              },
              restoredInMemory: () =>
                oauth.isPrefer() === previousOauthPreference,
              memoryRestoredContext: `The previous ${oauth.label} subscription preference appears restored in memory, but persistence could not be confirmed`,
              restoreFailedContext: `Could not restore the ${oauth.label} subscription preference`,
            },
          ]),
      ...(codingPlanRollback ? [codingPlanRollback] : []),
    ]);
    throwWithRollbackFailures(error, rollbackFailures);
  }
}

async function switchRetryToPersonalCredentials(
  decision: ApprovalDecision,
  request: RetryApprovalPayload,
  options: {
    prepareRetry?: HostRetryInteractionOptions['prepareRetry'];
    preparationSignal: AbortSignal;
    commitQueue: PQueue;
  },
): Promise<void> {
  const signal = options.preparationSignal;

  const requestedProvider = request.data.errorDetails?.provider;
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
      request.tui.missingPersonalApiKeyMessage ??
        missingApiKeyRetryMessage(requestedProvider),
    );
  }
  // The presentation check is deliberately cached. Drop that cache only after
  // the uncached commit check so getClient() must read the current key.
  invalidateApiKeyCache();

  if (!options.prepareRetry) {
    throw new Error('The model client cannot be refreshed for this retry.');
  }
  const prepareRetry = options.prepareRetry;

  // A coding-plan switch must take effect BEFORE the client is rebuilt:
  // credential and endpoint resolution read the live plan preference (the GLM
  // coding endpoint is selected from it, and dual-backend Kimi models are
  // rerouted onto the coding endpoint only while it is on), so rebuilding
  // first would prepare the retry against the exhausted coding route. The
  // disable, preparation, and rollback all stay inside one commit-queue slot
  // so a second coding-plan retry cannot interleave: its disable must wait
  // until this retry's rollback (if any) has finished.
  const codingPlanId =
    decision.disableQuotaRoute !== undefined &&
    isCodingPlanQuotaRoute(decision.disableQuotaRoute)
      ? decision.disableQuotaRoute
      : undefined;
  const codingPlanRuntime = codingPlanId
    ? codingPlanSubscriptionRuntimes.find(
        (runtime) => runtime.descriptor.id === codingPlanId,
      )
    : undefined;
  if (codingPlanId && codingPlanRuntime) {
    const runtime = codingPlanRuntime;
    // Wrapped so a cancel settles this retry immediately instead of waiting
    // for an unrelated stream's commit or rollback to drain first. The task
    // still runs, and stops at the checks below.
    await runRetryTask(
      () =>
        options.commitQueue.add(async () => {
          signal.throwIfAborted();
          const previousCodingPlanEnabled = runtime.getEnabled();
          let codingPlanWriteStarted = false;
          try {
            codingPlanWriteStarted = true;
            await runRetryTask(
              () => setCliCodingPlanSubscription(codingPlanId, false),
              signal,
            );
            signal.throwIfAborted();
            await prepareRetryClient(prepareRetry, 'personal', signal);
          } catch (error) {
            throwWithRollbackFailures(
              error,
              await rollbackChangedSettings([
                codingPlanRollbackConfig(
                  runtime,
                  previousCodingPlanEnabled,
                  codingPlanWriteStarted,
                ),
              ]),
            );
          }
          await applyRetryCredentialCommit(
            decision,
            signal,
            codingPlanRollbackConfig(
              runtime,
              previousCodingPlanEnabled,
              codingPlanWriteStarted,
            ),
          );
        }),
      signal,
    );
  } else {
    await prepareRetryClient(prepareRetry, 'personal', signal);
    // Wrapped so a cancel settles this retry immediately instead of waiting
    // for an unrelated stream's commit or rollback to drain first. The task
    // still runs, and stops at the check below.
    await runRetryTask(
      () =>
        options.commitQueue.add(async () => {
          // The task can wait behind another stream's rollback, so the queue
          // may have cancelled this retry since it was scheduled.
          await applyRetryCredentialCommit(decision, signal);
        }),
      signal,
    );
  }
}

function handleExternalInquiry(
  payload: ExternalInquiryPermission,
  context: CliContext,
): void {
  const threadId = payload.threadId;
  if (!threadId) return;

  if (denyExternalInquiryIfNoHumanInput(threadId, context)) return;
  void enqueueTuiApproval({ kind: 'externalInquiry', data: payload }).then(
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
      if (decision.rejectionCause !== undefined) {
        void handleExternalInquiryAction({
          action: 'drop',
          threadId,
          cause: decision.rejectionCause,
        });
        return;
      }
      if (decision.userMessage) {
        void handleExternalInquiryAction({
          action: 'drop',
          threadId,
          feedback: decision.userMessage,
        });
        return;
      }
      void handleExternalInquiryAction({
        action: 'drop',
        threadId,
      });
    },
  );
}
