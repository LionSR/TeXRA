// TUI side of the request protocol (PRD one-fold-three-renderers, 10.1).
//
// A run asks a person with `request.opened`; the fold lists it in
// `view.requests` until a `request.decided` answers it, and the modal reads
// that list (`approvalQueue.ts`). This module owns only what a request needs
// before it can be shown or answered on this host: the CLI policy's own
// answer for the kinds it settles with nobody to ask, a retry's personal-key
// lookup and the unattended switch that lookup enables, and the credential
// work behind a retry on the user's own key — the `useOwnApiKey` capability a
// decision names instead of answering itself.
//
// The attached host answers nothing: it stages a tool edit's preview,
// mirrors bypass state onto its wire, and presents events.

import { computed } from '@lit-labs/signals';
import PQueue from 'p-queue';

import type { HostInteractions } from '@agent/runtime';
import {
  cliRetryQuotaRoute,
  isCliApiSwitchableRetry,
} from '@cli/runtime/approval/approvalPrompts';
import {
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
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { RetryPermission } from '@shared/schemas';
import {
  isCodingPlanQuotaRoute,
  type QuotaFallbackRoute,
  type QuotaFallbackRouteId,
} from '@shared/quotaFallbackRoutes';
import type { HostRequest } from '@shared/session/hostRequest';
import { subscribeToSignalChanges } from '@shared/signals';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import { bumpCodexPreferenceVersion } from './cliState';
import {
  setCliCodingPlanSubscription,
  setCliSubscriptionPreference,
} from './subscriptionPreference';
import {
  attentionRequests,
  currentApproval,
  decidePendingRequest,
  landRequestDecision,
  stagePresentation,
  useHostCapability,
} from './approvalQueue';
import { currentView } from './sessionView';

/**
 * The process stores a retry's credential work reads: the secret store its
 * key checks go through, and the global state a rolled-back coding-plan
 * preference is written straight into. Both come from the chat session's
 * caller, which holds them already.
 */
interface TuiApprovalStores {
  readonly secrets: PlatformSecrets;
  readonly state: StateStore;
}

/** The pending requests this surface watches, as a level it subscribes to. */
const pendingRequests = computed(() => attentionRequests(currentView()));

/**
 * Create the TUI's presentation host, and answer for its lifetime the
 * pending requests this host settles without the modal.
 */
export function createTuiHostInteractions(
  host: CliRuntimeHost,
  context: CliContext,
  stores: TuiApprovalStores,
): HostInteractions {
  // The two persisted access fields commit as one choice within this TUI
  // lifetime. Keeping the queue session-owned prevents stale work leaking
  // across disposed hosts or tests.
  const retryCredentialCommitQueue = new PQueue({ concurrency: 1 });
  /** Set by `dispose`: an attachment that is gone answers for nobody, so its
   *  queued credential work must not reach the user's settings. */
  let disposed = false;
  /** Requests this attachment has already acted on, pruned as they settle. */
  const acted = new Set<string>();
  /** The undo this guard hands every decision it sends: a refused
   *  `request.decide` answered nothing, and the queue drops its own decided
   *  entry, so this entry must go too or no later level acts on the request
   *  again — and an automatically settled plan, question, or retry has no
   *  staged modal the user could answer it through. */
  const actAgainOnRefusal = (requestId: string) => (): void => {
    acted.delete(requestId);
  };
  /** Retries this host switched without asking, which get the notification. */
  const automaticSwitches = new Set<string>();

  const pendingRetry = (requestId: string): RetryPermission | undefined => {
    const pending = currentView().requests.find(
      (request) => request.requestId === requestId,
    );
    return pending?.payload.kind === 'retry' ? pending.payload.data : undefined;
  };

  /**
   * A retry on the user's own key: check the stored credential and turn off
   * the preference that routed onto the exhausted one, then decide the retry
   * on personal credentials. The run rebuilds its binding when it reads that
   * decision, so the preference must already be off here.
   */
  const useOwnApiKey = (requestId: string): void => {
    const permission = pendingRetry(requestId);
    if (!permission) {
      logWarning(
        'cli.tui',
        `Request ${requestId} is no longer a pending retry: no credential switch was made.`,
      );
      return;
    }
    void (async () => {
      try {
        const switched = await switchRetryToPersonalCredentials(
          permission,
          cliRetryQuotaRoute(permission),
          {
            commitQueue: retryCredentialCommitQueue,
            stores,
            // Re-read at the commit itself: the key lookup and the queue slot
            // ahead of this one both take time, and a retry another surface
            // settled meanwhile must not change the user's access settings.
            isPending: () => !disposed && pendingRetry(requestId) !== undefined,
          },
        );
        if (!switched) {
          logWarning(
            'cli.tui',
            `Request ${requestId} was settled elsewhere before its credential switch committed: no access setting was changed.`,
          );
          return;
        }
        // Switching without asking also skips the modal's quota warning, and
        // the switch persists the plan preference as disabled. Announce it
        // only after the switch commits: a failure rolls the preference back,
        // and the user must not be told a switch happened that did not.
        if (automaticSwitches.has(requestId)) notify('credentialSwitched');
        // The decision lands as itself, not through the surface decision
        // vocabulary: a personal-credential retry decomposes into this very
        // capability, so re-deciding it here would call back into this
        // function and the request would never be answered.
        landRequestDecision(
          permission.runId,
          requestId,
          { action: 'retry', credentials: 'personal' },
          actAgainOnRefusal(requestId),
        );
      } catch (error) {
        logWarning(
          'cli.tui',
          `The retry could not switch to your own API key: ${toErrorMessage(error)}`,
        );
        landRequestDecision(
          permission.runId,
          requestId,
          { action: 'deny', reason: toErrorMessage(error) },
          actAgainOnRefusal(requestId),
        );
      }
    })();
  };

  const performHostCapability = (arm: HostRequest): void => {
    if (arm.kind === 'useOwnApiKey') {
      useOwnApiKey(arm.requestId);
      return;
    }
    // Every other capability belongs to a windowed host's surfaces; no TUI
    // action names one, so reaching here is a defect.
    logWarning(
      'cli.tui',
      `The TUI does not perform the ${arm.kind} host capability.`,
    );
  };

  /**
   * A retry's presentation: the keychain lookup that decides whether `k` is
   * offered, and the switch a coding-plan quota permits without asking.
   * Coding-plan quotas (Kimi Code, GLM Coding Plan) have a fallback route
   * that re-uses an already-stored key, so this host switches when that key
   * exists — which is what lets a delegated subagent recover with no human
   * present. OAuth subscriptions (ChatGPT, Grok) stay explicit: changing
   * credential ownership must not hide the quota warning or silently spend
   * API-key quota. Kimi Code-exclusive models never reach the switch: the
   * classifier gates them to no route, so they keep the modal.
   */
  const prepareRetry = (permission: RetryPermission): void => {
    const requestId = permission.requestId;
    if (!isCliApiSwitchableRetry(permission)) {
      stagePresentation({ kind: 'retry', data: permission, tui: {} });
      return;
    }
    void (async () => {
      let personalApiKeyAvailable = false;
      let missingPersonalApiKeyMessage: string | undefined;
      // Every step of the preparation, the copy lookup included, stays inside
      // the try: preparation only adorns the card, so a failure here must
      // still stage it. A request whose modal never appears waits on nobody.
      try {
        const requestedProvider = permission.errorDetails?.provider;
        const provider =
          requestedProvider && isApiProvider(requestedProvider)
            ? requestedProvider
            : undefined;
        missingPersonalApiKeyMessage = missingApiKeyRetryMessage(provider);
        if (provider) {
          try {
            personalApiKeyAvailable = await hasUsableApiKey(
              stores.secrets,
              provider,
            );
          } catch (error) {
            // A keychain failure must not permit a credential switch nobody asked for.
            logWarning(
              'cli.tui',
              `Keychain lookup for ${provider} failed: ${toErrorMessage(error)}`,
            );
            personalApiKeyAvailable = false;
            missingPersonalApiKeyMessage = missingApiKeyRetryMessage(
              provider,
              'unavailable',
            );
          }
        }
        const route = cliRetryQuotaRoute(permission);
        if (
          personalApiKeyAvailable &&
          route &&
          isCodingPlanQuotaRoute(route.id)
        ) {
          automaticSwitches.add(requestId);
          useOwnApiKey(requestId);
          return;
        }
      } catch (error) {
        // The card shows on the payload alone: no own-key offer, since
        // nothing here proved a stored key exists.
        personalApiKeyAvailable = false;
        logWarning(
          'cli.tui',
          `The retry card for request ${requestId} could not be prepared: ${toErrorMessage(error)}`,
        );
      }
      stagePresentation({
        kind: 'retry',
        data: permission,
        tui: { personalApiKeyAvailable, missingPersonalApiKeyMessage },
      });
    })();
  };

  /**
   * What this host does with each newly listed request: the policy's own
   * decision for a gated plan or delegation, the denial a run with no human
   * input available gets for a question, and a retry's preparation. Bash and
   * tool-edit policy is decided at the tool boundary before their request
   * opens, so those always wait for the modal.
   */
  const answerPendingRequests = (): void => {
    const pending = pendingRequests.get();
    const live = new Set(pending.map((request) => request.requestId));
    for (const id of acted) if (!live.has(id)) acted.delete(id);
    for (const id of automaticSwitches) {
      if (!live.has(id)) automaticSwitches.delete(id);
    }
    for (const request of pending) {
      if (acted.has(request.requestId)) continue;
      acted.add(request.requestId);
      const payload = request.payload;
      switch (payload.kind) {
        case 'bash':
        case 'toolEdit':
          continue;
        case 'planApproval':
        case 'proposal': {
          const settled = settleExecutable(context, request.runId);
          if (settled) {
            decidePendingRequest(
              request.requestId,
              settled,
              actAgainOnRefusal(request.requestId),
            );
          }
          continue;
        }
        case 'userQuestion': {
          const denial = settleHumanInputDenial(context, request.runId);
          if (denial) {
            decidePendingRequest(
              request.requestId,
              { action: 'deny', reason: denial.reason },
              actAgainOnRefusal(request.requestId),
            );
          }
          continue;
        }
        case 'retry': {
          const settled = settleRetry(payload.data, context);
          if (settled) {
            decidePendingRequest(
              request.requestId,
              settled,
              actAgainOnRefusal(request.requestId),
            );
            continue;
          }
          prepareRetry(payload.data);
          continue;
        }
      }
    }
  };

  answerPendingRequests();
  const unsubscribe = subscribeToSignalChanges(
    [pendingRequests],
    answerPendingRequests,
  );
  const releaseCapability = useHostCapability(performHostCapability);

  return {
    emit: (event, payload) => host.emit(event, payload),
    /** The preview a tool edit's durable payload cannot carry. */
    presentToolEdit(request) {
      stagePresentation({
        kind: 'toolEdit',
        data: request.permission,
        tui: {
          originalContent: request.originalContent,
          proposedContent: request.proposedContent,
        },
      });
    },
    // The badge reads the fold's policy snapshot; the host only mirrors the
    // change onto its NDJSON wire.
    setApprovalBypassState(update) {
      host.emitApprovalBypassState(update);
    },
    dispose() {
      disposed = true;
      unsubscribe();
      releaseCapability();
    },
  };
}

/**
 * Ring the terminal when a request first becomes the foreground modal. One
 * subscription per TUI session; a re-presentation after a promotion never
 * re-fires it. The selection stays where it is: a descendant's request shows
 * over the selected stream (`approvalVisibleForSelection`), and any other
 * waits behind the status bar's count and the session list's marker until
 * the user goes to it.
 */
export function announceForegroundApprovals(): () => void {
  const announced = new Set<string>();
  const check = (): void => {
    const pending = currentApproval.get();
    if (!pending) return;
    const id = pending.payload.data.requestId;
    if (announced.has(id)) return;
    announced.add(id);
    notify('approvalNeeded');
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
 * restore (a switch that failed while disabling the plan) and the commit
 * task's rollback (a later access-settings write failed).
 *
 * Both callers sit past the point where the plan write was attempted, so
 * `writeStarted` is always true here.
 */
function codingPlanRollbackConfig(
  runtime: CodingPlanSubscriptionRuntime,
  previous: boolean,
  state: StateStore,
): RetrySettingRollbackConfig {
  return {
    writeStarted: true,
    needsRollback: () => runtime.getEnabled() !== previous,
    restore: async () => {
      await runtime.restoreEnabled(previous, state);
      bumpCodexPreferenceVersion();
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
  routeId: QuotaFallbackRouteId | undefined,
  codingPlanRollback?: RetrySettingRollbackConfig,
): Promise<void> {
  const oauth = oauthCliPreference(routeId);
  const previousOauthPreference = oauth?.isPrefer() ?? false;
  let subscriptionWriteStarted = false;
  try {
    if (oauth) {
      subscriptionWriteStarted = true;
      const update = await oauth.setPrefer(false);
      if (update.effective) {
        throw new Error(
          `${oauth.label} subscription remains enabled by a more specific setting.`,
        );
      }
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

/**
 * Put the user's own credential in place for one retry: verify the stored
 * key, then turn off the preference that routed onto the exhausted one.
 * Throws when the switch cannot be made, with every setting it touched put
 * back, so the caller can say so instead of retrying on a route that has not
 * changed. Returns false, having written nothing, when `isPending` says the
 * request is gone by the time the commit slot is this switch's: access
 * settings are the user's, not one dead request's.
 */
async function switchRetryToPersonalCredentials(
  permission: RetryPermission,
  route: QuotaFallbackRoute | undefined,
  options: {
    readonly commitQueue: PQueue;
    readonly stores: TuiApprovalStores;
    /** Whether the request this switch serves is still pending on a live
     *  attachment. Read inside the commit slot, immediately before the first
     *  persistent write. */
    readonly isPending: () => boolean;
  },
): Promise<boolean> {
  const requestedProvider = permission.errorDetails?.provider;
  if (!requestedProvider || !isApiProvider(requestedProvider)) {
    throw new Error(
      'The failed API provider could not be identified, so TeXRA did not change access settings.',
    );
  }
  const keyExists = await apiKeyExistsUncached(
    options.stores.secrets,
    requestedProvider,
  );
  if (!keyExists) {
    throw new Error(missingApiKeyRetryMessage(requestedProvider));
  }
  // The presentation check is deliberately cached. Drop that cache only after
  // the uncached commit check so the next binding reads the current key.
  invalidateApiKeyCache();

  // A coding-plan switch must take effect BEFORE the run rebinds on this
  // decision: credential and endpoint resolution read the live plan
  // preference (the GLM coding endpoint is selected from it, and
  // dual-backend Kimi models are rerouted onto the coding endpoint only while
  // it is on), so deciding first would retry against the exhausted coding
  // route. The disable, the commit, and any rollback stay inside one
  // commit-queue slot so a second coding-plan retry cannot interleave: its
  // disable waits until this retry's rollback (if any) has finished.
  const codingPlanId =
    route && isCodingPlanQuotaRoute(route.id) ? route.id : undefined;
  const codingPlanRuntime = codingPlanId
    ? codingPlanSubscriptionRuntimes.find(
        (runtime) => runtime.descriptor.id === codingPlanId,
      )
    : undefined;
  if (codingPlanId && codingPlanRuntime) {
    const runtime = codingPlanRuntime;
    return (
      (await options.commitQueue.add(async () => {
        if (!options.isPending()) return false;
        const previousCodingPlanEnabled = runtime.getEnabled();
        try {
          await setCliCodingPlanSubscription(codingPlanId, false);
        } catch (error) {
          throwWithRollbackFailures(
            error,
            await rollbackChangedSettings([
              codingPlanRollbackConfig(
                runtime,
                previousCodingPlanEnabled,
                options.stores.state,
              ),
            ]),
          );
        }
        await applyRetryCredentialCommit(
          route?.id,
          codingPlanRollbackConfig(
            runtime,
            previousCodingPlanEnabled,
            options.stores.state,
          ),
        );
        return true;
      })) === true
    );
  }
  return (
    (await options.commitQueue.add(async () => {
      if (!options.isPending()) return false;
      await applyRetryCredentialCommit(route?.id);
      return true;
    })) === true
  );
}
