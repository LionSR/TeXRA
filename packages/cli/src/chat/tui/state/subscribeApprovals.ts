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

import { Effect } from 'effect';
import { computed } from '@lit-labs/signals';

import type { HostInteractions, SessionHandle } from '@agent/runtime';
import {
  cliRetryQuotaRoute,
  isCliApiSwitchableRetry,
} from '@cli/runtime/approval/approvalPrompts';
import {
  settleExecutable,
  settleHumanInputDenial,
  settleRetry,
} from '@cli/runtime/approval/settleApprovals';
import { promptForCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { missingApiKeyRetryMessage } from '@cli/tui/ui/retryCopy';
import {
  ApiKeyPromptFailed,
  ProgressApiKeyRetryController,
} from '@controllers/progressView/ProgressApiKeyRetryController';
import { warn as logWarning } from '@logger/logUtils';
import {
  API_PROVIDERS,
  hasUsableApiKey,
  isApiProvider,
  lookupApiKeyUncached,
} from '@model/apiProviders';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { getExhaustionReason, type RetryPermission } from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { isCodingPlanQuotaRoute } from '@shared/quotaFallbackRoutes';
import type { HostRequest } from '@shared/session/hostRequest';
import { subscribeToSignalChanges } from '@shared/signals';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import {
  attentionRequests,
  currentApproval,
  decidePendingRequest,
  dropPresentation,
  forgetSettledRequests,
  landRequestDecision,
  stagePresentation,
  useHostCapability,
} from './approvalQueue';
import { currentView } from './sessionView';

/**
 * What this host holds for its lifetime: the session its policy settlements
 * read and its decisions land on, the secret store and settings slots a
 * retry's credential switch goes through, and the runtime its decisions are
 * issued on. All four come from the chat session's caller, which holds them
 * already.
 */
interface TuiApprovalStores {
  /** The chat's session: `/approval` writes land here between turns, so a
   *  settlement reads the live policy from it rather than the launch-time
   *  CliContext value. */
  readonly session: SessionHandle;
  readonly secrets: PlatformSecrets;
  /** The settings slots a key prompt reads a provider's display name and key
   *  URL from, so a retry that has to ask for a credential words the ask the
   *  same way `/key` does. */
  readonly settings: SettingsStores;
  /** The process runtime this attachment's decisions are issued on, held for
   *  the host's lifetime rather than looked up per decision. */
  readonly runtime: ProcessRuntime;
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
    switched.delete(requestId);
  };
  /** Retries this host has already landed a personal-credential decision
   *  for. The fold lags the decision, so this is what tells the switch's own
   *  program that it landed rather than fell through to a denial. */
  const switched = new Set<string>();
  /** Retries this host switched without asking, which get the notification. */
  const automaticSwitches = new Set<string>();

  const pendingRetry = (requestId: string): RetryPermission | undefined => {
    const pending = attentionRequests(currentView()).find(
      (request) => request.requestId === requestId,
    );
    return pending?.payload.kind === 'retry' ? pending.payload.data : undefined;
  };

  /**
   * The shared credential-switch policy, bound to this host's stores: which
   * provider a quota-exhausted route falls back to, whether the user already
   * has a usable key for it, and the prompt that asks for one when they do
   * not. Only the decision this host lands on the request is its own — the
   * rules above it are the same three ways on every host.
   */
  const apiKeyRetry = new ProgressApiKeyRetryController({
    providers: API_PROVIDERS,
    readKey: (provider) => lookupApiKeyUncached(stores.secrets, provider),
    hasUsableKey: (provider) => hasUsableApiKey(stores.secrets, provider),
    promptForApiKey: (provider) =>
      provider
        ? promptForCliProviderApiKey(
            stores.secrets,
            stores.settings,
            provider,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ApiKeyPromptFailed({
                  provider,
                  message: toErrorMessage(cause),
                  cause,
                }),
            ),
          )
        : Effect.fail(
            new ApiKeyPromptFailed({
              provider: undefined,
              message:
                'The failed API provider could not be identified, so TeXRA did not ask for a key.',
            }),
          ),
    isRetryPending: (_stream, requestId) =>
      !disposed && pendingRetry(requestId) !== undefined,
    triggerRetry: (runId, requestId) =>
      Effect.sync(() => {
        switched.add(requestId);
        // The notice belongs to the switch itself, not to the program that
        // asked for it: the controller only reaches here on a live
        // attachment (`isRetryPending`), and saying it here cannot race the
        // fold dropping the request.
        if (automaticSwitches.has(requestId)) notify('credentialSwitched');
        // This capability already selected the credential route; decomposing
        // the decision again would call the capability recursively.
        landRequestDecision(
          stores.session,
          stores.runtime,
          runId,
          requestId,
          { action: 'retry', credentials: 'personal' },
          actAgainOnRefusal(requestId),
        );
        return true;
      }),
  });

  /**
   * A retry on the user's own key: the shared controller resolves the
   * credential owner, checks the store, asks for a key when there is none,
   * and lands the retry through `triggerRetry`. What stays here is the
   * answer a switch that did not happen still owes the run: the request is
   * durable and nobody else re-asks it, so it leaves as a denial worded for
   * this surface rather than as a card the user can no longer see.
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
    const requestedProvider = permission.errorDetails?.provider;
    const provider =
      requestedProvider && isApiProvider(requestedProvider)
        ? requestedProvider
        : undefined;
    stores.runtime.runFork(
      Effect.gen(function* () {
        const failure = yield* Effect.match(
          apiKeyRetry.useOwnApiKey({
            stream: permission.runId,
            requestId,
            provider,
            model: permission.model,
            exhaustionReason: getExhaustionReason(permission.errorDetails),
          }),
          {
            onSuccess: () => undefined,
            onFailure: (error) => toErrorMessage(error),
          },
        );
        // Read the local fact, not the fold: `triggerRetry` lands its
        // decision on the session's own queue, so the request can still be
        // listed here for a moment after the switch committed.
        if (switched.has(requestId)) return;
        // Success and failure have the same lifetime: a lookup that finishes
        // after this attachment leaves must not answer for its next owner.
        if (disposed || pendingRetry(requestId) === undefined) return;
        const reason = failure ?? missingApiKeyRetryMessage(provider);
        logWarning(
          'cli.tui',
          `The retry could not switch to your own API key: ${reason}`,
        );
        landRequestDecision(
          stores.session,
          stores.runtime,
          permission.runId,
          requestId,
          { action: 'deny', reason },
          actAgainOnRefusal(requestId),
        );
      }),
    );
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
    const requestedProvider = permission.errorDetails?.provider;
    const provider =
      requestedProvider && isApiProvider(requestedProvider)
        ? requestedProvider
        : undefined;
    stores.runtime.runFork(
      Effect.gen(function* () {
        // Preparation only adorns the card, so no lookup outcome may stop it
        // from being staged: a request whose modal never appears waits on
        // nobody. The keychain read folds to the card copy either way.
        const tui = provider
          ? yield* Effect.match(hasUsableApiKey(stores.secrets, provider), {
              onSuccess: (personalApiKeyAvailable) => ({
                personalApiKeyAvailable,
                missingPersonalApiKeyMessage:
                  missingApiKeyRetryMessage(provider),
              }),
              onFailure: (error) => {
                // A keychain failure must not permit a credential switch nobody asked for.
                logWarning(
                  'cli.tui',
                  `Keychain lookup for ${provider} failed: ${toErrorMessage(error)}`,
                );
                return {
                  personalApiKeyAvailable: false,
                  missingPersonalApiKeyMessage: missingApiKeyRetryMessage(
                    provider,
                    'unavailable',
                  ),
                };
              },
            })
          : {
              personalApiKeyAvailable: false,
              missingPersonalApiKeyMessage: missingApiKeyRetryMessage(provider),
            };
        // Preparation has the same attachment lifetime as the decision: an
        // old lookup cannot replace the next host's card or switch its retry.
        if (disposed || pendingRetry(requestId) === undefined) return;
        const route = cliRetryQuotaRoute(permission);
        if (
          tui.personalApiKeyAvailable &&
          route &&
          isCodingPlanQuotaRoute(route.id)
        ) {
          automaticSwitches.add(requestId);
          useOwnApiKey(requestId);
          return;
        }
        stagePresentation({ kind: 'retry', data: permission, tui });
      }),
    );
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
    for (const id of switched) if (!live.has(id)) switched.delete(id);
    for (const request of pending) {
      if (acted.has(request.requestId)) continue;
      const payload = request.payload;
      switch (payload.kind) {
        case 'bash':
        case 'toolEdit':
          continue;
        case 'planApproval':
        case 'proposal': {
          const settled = settleExecutable(
            stores.session,
            context,
            request.runId,
          );
          if (settled) {
            acted.add(request.requestId);
            decidePendingRequest(
              stores.session,
              stores.runtime,
              request.requestId,
              settled,
              actAgainOnRefusal(request.requestId),
            );
          }
          continue;
        }
        case 'userQuestion': {
          const denial = settleHumanInputDenial(
            stores.session,
            context,
            request.runId,
          );
          if (denial) {
            acted.add(request.requestId);
            decidePendingRequest(
              stores.session,
              stores.runtime,
              request.requestId,
              { action: 'deny', reason: denial.reason },
              actAgainOnRefusal(request.requestId),
            );
          }
          continue;
        }
        case 'retry': {
          acted.add(request.requestId);
          const settled = settleRetry(stores.session, payload.data, context);
          if (settled) {
            decidePendingRequest(
              stores.session,
              stores.runtime,
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
    // The CLI host renders the notice itself and says whether it rendered a
    // user-visible record; there is no program for the session to fork.
    emit: (event, payload) => {
      host.emit(event, payload);
    },
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
    // `forgetSettledRequests` only drops a presentation whose request the
    // fold listed at least once, so a request whose `request.opened` never
    // committed is released by id here.
    releaseToolEdit: dropPresentation,
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
