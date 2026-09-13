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
import { warn as logWarning } from '@logger/logUtils';
import {
  apiKeyExistsUncached,
  hasUsableApiKey,
  invalidateApiKeyCache,
  isApiProvider,
} from '@model/apiProviders';
import type { PlatformSecrets } from '@platform/secrets';
import type { RetryPermission } from '@shared/schemas';
import { isCodingPlanQuotaRoute } from '@shared/quotaFallbackRoutes';
import type { HostRequest } from '@shared/session/hostRequest';
import { subscribeToSignalChanges } from '@shared/signals';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import {
  attentionRequests,
  currentApproval,
  decidePendingRequest,
  forgetSettledRequests,
  landRequestDecision,
  stagePresentation,
  useHostCapability,
} from './approvalQueue';
import { currentView } from './sessionView';

/**
 * The process store a retry's credential work reads: the secret store its
 * key checks go through. It comes from the chat session's caller, which
 * holds it already.
 */
interface TuiApprovalStores {
  readonly secrets: PlatformSecrets;
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
  /** Set by `dispose`: an attachment that is gone answers for nobody, so it
   *  must not decide a request the next owner will. */
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
   * A retry on the user's own key: check the stored credential, then decide
   * the retry on personal credentials. The run rebuilds its binding when it
   * reads that decision and declines the exhausted subscription route for
   * itself, so nothing here writes the user's access settings.
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
        await ensurePersonalApiKey(permission, stores);
        // Re-read after the key lookup, which takes time: a retry another
        // surface settled meanwhile is not this attachment's to decide.
        if (disposed || pendingRetry(requestId) === undefined) {
          logWarning(
            'cli.tui',
            `Request ${requestId} was settled elsewhere before its credential switch: nothing was decided here.`,
          );
          return;
        }
        // Switching without asking also skips the modal's quota warning, so
        // say it happened.
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
    // Every level prunes what this host staged for requests that have left
    // it, however they settled: a decision taken on another surface or a run
    // interruption drops the fact without passing through this surface.
    forgetSettledRequests(live);
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
 * Put the user's own credential in place for one retry: verify that a usable
 * key for the failed provider is stored, so the caller can decide the retry
 * on personal credentials instead of retrying onto a route that has not
 * changed. Nothing is written: the run declines the exhausted subscription
 * route for itself when it reads the decision, and the user's access
 * settings stay theirs.
 */
async function ensurePersonalApiKey(
  permission: RetryPermission,
  stores: TuiApprovalStores,
): Promise<void> {
  const requestedProvider = permission.errorDetails?.provider;
  if (!requestedProvider || !isApiProvider(requestedProvider)) {
    throw new Error(
      'The failed API provider could not be identified, so TeXRA did not switch this retry to your own key.',
    );
  }
  const keyExists = await apiKeyExistsUncached(
    stores.secrets,
    requestedProvider,
  );
  if (!keyExists) {
    throw new Error(missingApiKeyRetryMessage(requestedProvider));
  }
  // The presentation check is deliberately cached. Drop that cache after the
  // uncached check so the next binding reads the current key.
  invalidateApiKeyCache();
}
