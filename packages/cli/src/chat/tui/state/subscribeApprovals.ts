// TUI implementation of the session-owned HostInteractions port (PRD
// one-fold-three-renderers, 10.1).
//
// The runtime publishes `approval.requested` before it dispatches a request
// here, and the fold lists it in `view.approvals` until `approval.resolved`;
// the modal reads that list (`approvalQueue.ts`). A hook therefore parks:
// its promise stays pending while the surface answers through a
// `decision.*` runtime request, which settles the runtime's pending set.
// Three kinds still settle through their hook, because the runtime has no
// request arm for them yet or their answer is host work: a tool edit (no
// `decision.toolEdit` arm), a retry (its credential switch and
// `prepareRetry` run on this host), and an external inquiry (a durable
// thread, not a pending request). Each takes a host reservation the modal
// reads its presentation payload from.
//
// Policy is honored at the shared tool boundary before a request reaches
// this port for bash and edits; plans, proposals, retries, and human-input
// requests keep their CLI policy decision here, answered on the spot.

import PQueue from 'p-queue';

import {
  currentSession,
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
} from '@agent/runtime';
import {
  toApprovalSettlement,
  toToolEditResult,
} from '@cli/runtime/approvalAdapter';
import {
  cliRetryQuotaRoute,
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
  type PermissionPayload,
  type PlanApprovalPermission,
  type StreamTabId,
} from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import { handleExternalInquiryAction } from '@tools/inquiry/inquiryActions';
import { onAbort } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import { foregroundReader } from './cliState';
import { isWorkflowScriptStream, presentStream } from './childControls';
import { currentView, streamViewOf } from './sessionView';
import {
  refreshSubscriptionPreferenceViews,
  setCliCodingPlanSubscription,
  setCliSubscriptionPreference,
} from './subscriptionPreference';
import {
  approvalPayloadStreamId,
  currentApproval,
  reserveHostRequest,
  settleHostRequestsWhere,
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
  // Coding-plan quotas (Kimi Code, GLM Coding Plan) have a fallback route that
  // re-uses an already-stored key, so auto-switch when that key exists.
  // OAuth subscriptions (ChatGPT, Grok) stay explicit: the user must confirm.
  // Kimi Code-exclusive models never reach this branch: the classifier gates
  // them to no route, keeping the modal without an API-key switch.
  const route = cliRetryQuotaRoute(payload.data);
  if (!route || !isCodingPlanQuotaRoute(route.id)) return undefined;
  if (payload.tui.personalApiKeyAvailable !== true) return undefined;
  return { accepted: true, disableQuotaRoute: route.id };
}

/** A request the surface answers through a `decision.*` runtime request:
 *  the hook's promise stays pending; the runtime's own settlement resolves
 *  the caller. A streamless request has no fact for the fold to list, so
 *  nothing could answer it; it is declined rather than parked forever. */
function park<T>(
  kind: PermissionPayload['kind'],
  streamId: StreamTabId | string | null | undefined,
): Promise<T> | undefined {
  if (!streamId) {
    logWarning(
      'cli.tui',
      `A ${kind} request named no stream; the TUI cannot present it.`,
    );
    return undefined;
  }
  return new Promise<T>(() => {});
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
  // Identity of this attachment's host reservations.
  const interactionOwner = {};

  return {
    emit: (event, payload) => host.emit(event, payload),
    async requestToolEditApproval(request) {
      // The prompt the tool boundary prepared is the `approval.requested`
      // payload: presenting it keeps one requestId per request.
      const reservation = reserveHostRequest(
        {
          kind: 'toolEdit',
          data: request.permission,
          tui: {
            originalContent: request.originalContent,
            proposedContent: request.proposedContent,
          },
        },
        { owner: interactionOwner, presentable: true },
      );
      try {
        const decision = await reservation.decided;
        return toToolEditResult(decision, request.proposedContent);
      } finally {
        reservation.release();
      }
    },
    requestBashApproval(request: HostBashApprovalRequest) {
      return park<BashSettlement>('bash', request.streamId);
    },
    requestPlanApproval(request: PlanApprovalPermission) {
      return (
        settleByPolicy<PlanApprovalResult>(context) ??
        park('planApproval', request.streamId)
      );
    },
    requestAgentProposal(request: AgentProposalPermission) {
      return (
        settleByPolicy<ProposalResult>(context) ??
        park('proposal', request.streamId)
      );
    },
    requestRetry(request, options) {
      return requestRetryInteraction(
        request,
        context,
        { owner: interactionOwner, commitQueue: retryCredentialCommitQueue },
        options,
      );
    },
    askUserQuestion(request: HostUserQuestionRequest) {
      const denial = settleHumanInputDenial(context);
      if (denial != null) {
        return Promise.resolve<UserQuestionSettlement>({
          action: 'reject',
          reason: denial.reason,
        });
      }
      return park<UserQuestionSettlement>('userQuestion', request.streamId);
    },
    async openExternalInquiry(request) {
      handleExternalInquiry(request, context, interactionOwner);
    },
    // The badge reads the fold's policy snapshot; the host only mirrors the
    // change onto its NDJSON wire.
    setApprovalBypassState(update) {
      host.emitApprovalBypassState(update);
    },
    // The runtime settles its own pending set; this drops the host's hold on
    // the hook-settled kinds so their work stops.
    cancel(selector: HostInteractionCancelSelector = {}) {
      settleHostRequestsWhere(
        (payload) =>
          matchesCancelSelector(
            { kind: payload.kind, streamId: approvalPayloadStreamId(payload) },
            selector,
          ),
        {
          accepted: false,
          rejectionCause: selector.cause ?? 'Approval request was cancelled.',
        },
      );
    },
    dispose() {
      // Only the reservations bound to this host's work (its key lookup and
      // credential commit queue) settle on detach; a newer host's belong to
      // that host, and the runtime's requests stay decidable there.
      settleHostRequestsWhere((_payload, owner) => owner === interactionOwner);
    },
  };
}

/** The CLI policy's answer for a gated plan or proposal, or undefined to ask. */
function settleByPolicy<T extends PlanApprovalResult | ProposalResult>(
  context: CliContext,
): Promise<T> | undefined {
  const policy = settleExecutable(context);
  if (!policy) return undefined;
  if (policy.accepted) return Promise.resolve({ action: 'approve' } as T);
  return Promise.resolve(
    toApprovalSettlement({
      accepted: false,
      rejectionReason: policy.userMessage ?? '',
    }) as T,
  );
}

function runRetryTask<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const detach = onAbort(signal, () =>
      reject(
        signal.reason ??
          new DOMException('Retry preparation aborted.', 'AbortError'),
      ),
    );
    try {
      start().then(
        (value) => {
          detach();
          resolve(value);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
    } catch (error) {
      detach();
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

/**
 * The host reservation is this retry's liveness on this host: taking it
 * replaces whatever retry the same host held for the stream (its pre-modal
 * lookup, its modal, or the credential switch it had already started), and
 * holding it until `release` means a later cancel reaches the commit as
 * well. Nothing here re-checks whether the request is still current: a
 * settled entry ignores `present` and `settle`, and its abort signal stops
 * the work in flight.
 */
async function requestRetryInteraction(
  request: HostRetryRequest,
  context: CliContext,
  attachment: { readonly owner: object; readonly commitQueue: PQueue },
  options: HostRetryInteractionOptions | undefined,
): Promise<RetryResult> {
  settleHostRequestsWhere(
    (payload, owner) =>
      owner === attachment.owner &&
      payload.kind === 'retry' &&
      payload.data.streamId === request.streamId &&
      payload.data.requestId !== request.requestId,
  );
  const reservation = reserveHostRequest(
    { kind: 'retry', data: request, tui: {} },
    { owner: attachment.owner },
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
            } catch (error) {
              // A keychain failure must not permit an automatic credential
              // switch.
              logWarning(
                'cli.tui',
                `Keychain lookup for ${provider} failed: ${toErrorMessage(error)}`,
              );
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
      reservation.present(promptRequest);
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

/**
 * Focus the asking stream and ring the terminal when a request first
 * becomes the foreground modal. One subscription per TUI session; a
 * re-presentation after a promotion never re-fires it.
 */
export function announceForegroundApprovals(): () => void {
  const announced = new Set<string>();
  const announce = (payload: ApprovalPayload): void => {
    const streamId = approvalPayloadStreamId(payload);
    const reader = foregroundReader.get();
    const view = currentView();
    const workflowOwnsApproval =
      streamId !== undefined &&
      reader !== undefined &&
      isWorkflowScriptStream(view, reader.streamId) &&
      (streamViewOf(view, reader.streamId)?.childIds.includes(streamId) ??
        false);
    // Focus is this surface's own selection, never a fact.
    if (streamId && !workflowOwnsApproval) presentStream(streamId);
    notify('approvalNeeded');
  };
  const check = (): void => {
    const pending = currentApproval.get();
    if (!pending) return;
    const id = pending.payload.data.requestId;
    if (announced.has(id)) return;
    announced.add(id);
    announce(pending.payload);
  };
  check();
  return subscribeToSignalChanges([currentApproval], check);
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
 *
 * Each failure is contextualized rather than thrown, so a partially applied
 * switch can report every setting it could not put back rather than losing
 * all but the first. `restoredInMemory` separates "the value is back but the
 * write may not have persisted" from "the value is still the one the user
 * never asked for", because only the latter needs re-doing by hand.
 */
async function rollbackChangedSettings(
  configs: readonly RetrySettingRollbackConfig[],
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const config of configs) {
    if (!config.writeStarted || !config.needsRollback()) continue;
    try {
      await config.restore();
    } catch (rollbackError) {
      const persistenceContext = config.restoredInMemory()
        ? config.memoryRestoredContext
        : config.restoreFailedContext;
      failures.push(
        new Error(`${persistenceContext}: ${toErrorMessage(rollbackError)}`, {
          cause: rollbackError,
        }),
      );
    }
  }
  return failures;
}

/**
 * Rollback config for one coding-plan preference, shared by the pre-commit
 * restore (a switch that failed before or during client preparation) and the
 * commit task's rollback (a later access-settings write failed).
 *
 * Both callers sit past the point where the plan write was attempted, so
 * `writeStarted` is always true here.
 */
function codingPlanRollbackConfig(
  runtime: CodingPlanSubscriptionRuntime,
  previous: boolean,
): RetrySettingRollbackConfig {
  return {
    writeStarted: true,
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
  const oauth = oauthCliPreference(decision.disableQuotaRoute);
  const previousOauthPreference = oauth?.isPrefer() ?? false;
  let subscriptionWriteStarted = false;
  try {
    // Inside the try: a cancel landing on the coding-plan branch (where there
    // is no oauth write and so nothing else can throw here) must still roll
    // the already-disabled plan back rather than escape past the rollback.
    signal.throwIfAborted();
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
          try {
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
                codingPlanRollbackConfig(runtime, previousCodingPlanEnabled),
              ]),
            );
          }
          await applyRetryCredentialCommit(
            decision,
            signal,
            codingPlanRollbackConfig(runtime, previousCodingPlanEnabled),
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

/**
 * An external inquiry is a durable thread, not a runtime pending request:
 * the fold lists it in `view.inquiries` while open, and this host holds its
 * full question for the modal. The decision writes the thread through the
 * inquiry action, whose `inquiryThreadUpdated` fact closes it in the fold.
 */
function handleExternalInquiry(
  payload: ExternalInquiryPermission,
  context: CliContext,
  owner: object,
): void {
  const threadId = payload.threadId;
  if (!threadId) return;

  if (denyExternalInquiryIfNoHumanInput(threadId, context)) return;
  const reservation = reserveHostRequest(
    { kind: 'externalInquiry', data: payload },
    { owner, presentable: true },
  );
  void reservation.decided.then((decision) => {
    reservation.release();
    // User-accept with text submits an answer; empty text, reject, and
    // modal-cancel all drop the durable inquiry thread.
    let action: Parameters<typeof handleExternalInquiryAction>[0];
    if (decision.accepted && decision.userMessage) {
      action = { action: 'submit', threadId, answer: decision.userMessage };
    } else if (decision.rejectionCause !== undefined) {
      action = { action: 'drop', threadId, cause: decision.rejectionCause };
    } else if (decision.userMessage) {
      action = { action: 'drop', threadId, feedback: decision.userMessage };
    } else {
      action = { action: 'drop', threadId };
    }
    // Persisting the action writes the inquiry thread; nothing else owns
    // this promise, so its rejection is logged here instead of surfacing as
    // an unhandled rejection.
    handleExternalInquiryAction(action).catch((error: unknown) => {
      logWarning(
        'cli.tui',
        `External inquiry ${threadId} ${action.action} failed: ${toErrorMessage(error)}`,
      );
    });
  });
}
