// TUI side of the request protocol (PRD one-fold-three-renderers, 10.1).
//
// A run asks a person with `request.opened`; the fold lists it in
// `view.requests` until a `request.decided` answers it, and the modal reads
// that list (`approvalQueue.ts`). This module owns only what a request needs
// before it can be shown or answered on this host: the retry card it stages
// and the decision it lands for the `useOwnApiKey` capability. Whether a retry
// offers a move onto the user's own key, and whether that move was taken
// without asking, is the run's decision carried on the request; the key entry
// behind the capability is `ProgressApiKeyRetryController`'s, shared with the
// extension and desktop.
//
// The attached host answers nothing: it stages a tool edit's preview,
// mirrors bypass state onto its wire, and presents events.

import { Effect } from 'effect';

import {
  hasUsableApiKey,
  lookupApiKey,
  providerDisplayName,
} from '@texra-ai/llm';
import type { HostInteractions, SessionHandle } from '@agent/runtime';
import { warnApprovalDenied } from '@cli/runtime/approval/approvalPrompts';
import { promptForCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  ApiKeyPromptFailed,
  ProgressApiKeyRetryController,
} from '@controllers/progressView/ProgressApiKeyRetryController';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { RetryPermission } from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { HostRequest } from '@shared/session/hostRequest';
import { subscribeToSignalChanges } from '@shared/signals';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { notify } from '../notifications/terminalNotifier';
import {
  attentionRequests,
  currentApproval,
  dropPresentation,
  forgetSettledRequests,
  landRequestDecision,
  pruneToLive,
  reopenRequest,
  stagePresentation,
  useHostCapability,
} from './approvalQueue';
import { appendLocalNotice } from './transcript';

/**
 * What this host holds for its lifetime: the session its denial notices read
 * the policy from and its decisions land on, the secret store and settings
 * slots a retry's credential switch goes through, and the runtime its
 * decisions are issued on. All four come from the chat session's caller,
 * which holds them already.
 */
interface TuiApprovalStores {
  /** The chat's session: `/approval` writes land here between turns, so a
   *  denial notice names the live policy read from it rather than the
   *  launch-time CliContext value. */
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

/** Create the TUI's presentation host. */
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
  /** Retries this host has already landed a personal-credential decision
   *  for. The fold lags the decision, so this is what tells the switch's own
   *  program that it landed rather than fell through to a denial. */
  const switched = new Set<string>();
  /** The undo this guard hands every decision it sends: a refused
   *  `request.decide` answered nothing, and the queue drops its own decided
   *  entry, so this entry must go too or no later level acts on the request
   *  again — and an automatically settled plan, question, or retry has no
   *  staged modal the user could answer it through. */
  const actAgainOnRefusal = (requestId: string) => (): void => {
    acted.delete(requestId);
    switched.delete(requestId);
  };
  const pendingRetry = (requestId: string): RetryPermission | undefined => {
    const pending = attentionRequests
      .get()
      .find((request) => request.requestId === requestId);
    return pending?.payload.kind === 'retry' ? pending.payload.data : undefined;
  };

  /**
   * The shared key entry, bound to this host's stores: whether the user
   * already has a usable key for the provider the run's offer names, and the
   * prompt that asks for one when they do not. Only the decision this host
   * lands on the request is its own.
   */
  const apiKeyRetry = new ProgressApiKeyRetryController({
    readKey: (provider) => lookupApiKey(stores.secrets, provider),
    hasUsableKey: (provider) => hasUsableApiKey(stores.secrets, provider),
    promptForApiKey: (provider) =>
      promptForCliProviderApiKey(
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
      ),
    isRetryPending: (_stream, requestId) =>
      !disposed && pendingRetry(requestId) !== undefined,
    triggerRetry: (runId, requestId) =>
      Effect.sync(() => {
        switched.add(requestId);
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
   * A retry on the user's own key: the shared controller checks the store
   * for the key the run's offer names, asks for one when there is none, and
   * lands the retry through `triggerRetry`. A switch that did not happen
   * leaves the retry pending, as on every other host: the card comes back
   * with the reason worded into the conversation, and the user picks again.
   */
  const useOwnApiKey = (requestId: string): void => {
    const permission = pendingRetry(requestId);
    if (!permission) {
      stores.runtime.runFork(
        Effect.logWarning(
          `Request ${requestId} is no longer a pending retry: no credential switch was made.`,
        ).pipe(withLogChannel('cli.tui')),
      );
      return;
    }
    const offer = permission.credentialSwitch;
    // The Copilot route is the editor's; no run on this host binds it.
    if (offer == null || offer.kind === 'copilot-fallback') {
      stores.runtime.runFork(
        Effect.logWarning(
          `Retry ${requestId} offers no move onto a provider key: no credential switch was made.`,
        ).pipe(withLogChannel('cli.tui')),
      );
      reopenRequest(requestId);
      return;
    }
    const provider = offer.provider;
    stores.runtime.runFork(
      Effect.gen(function* () {
        const failure = yield* Effect.match(
          apiKeyRetry.useOwnApiKey({
            stream: permission.runId,
            requestId,
            provider,
            requireNewKey: offer.kind === 'new-key',
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
        const reason =
          failure ??
          `No ${providerDisplayName(provider)} API key was entered, so the retry did not switch to it. Use \`/key\` to add one.`;
        yield* Effect.logWarning(
          `The retry could not switch to your own API key: ${reason}`,
        ).pipe(withLogChannel('cli.tui'));
        appendLocalNotice(reason, permission.runId);
        reopenRequest(requestId);
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
    stores.runtime.runFork(
      Effect.logWarning(
        `The TUI does not perform the ${arm.kind} host capability.`,
      ).pipe(withLogChannel('cli.tui')),
    );
  };

  /**
   * What this host does with each newly listed request: a retry's card is
   * staged for the modal. The session decided everything its policy settles
   * before the request was listed, so what is listed waits for a person.
   */
  const answerPendingRequests = (): void => {
    const pending = attentionRequests.get();
    const live = new Set(pending.map((request) => request.requestId));
    // Every level prunes what this host staged for requests that have left
    // it, however they settled: a decision taken on another surface or a run
    // interruption drops the fact without passing through this surface.
    forgetSettledRequests(live);
    pruneToLive(live, acted, switched);
    for (const request of pending) {
      if (acted.has(request.requestId)) continue;
      if (request.payload.kind !== 'retry') continue;
      acted.add(request.requestId);
      stagePresentation({ kind: 'retry', data: request.payload.data });
    }
  };

  answerPendingRequests();
  const unsubscribe = subscribeToSignalChanges(
    [attentionRequests],
    answerPendingRequests,
  );
  const releaseCapability = useHostCapability(performHostCapability);

  return {
    approvalDenied: (denial, runId) =>
      warnApprovalDenied(stores.session, context, denial, runId),
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
    // A settled request is never presented again, so its entry leaves too.
    pruneToLive(
      new Set(attentionRequests.get().map((request) => request.requestId)),
      announced,
    );
    const id = pending.payload.data.requestId;
    if (announced.has(id)) return;
    announced.add(id);
    notify('approvalNeeded');
  };
  check();
  return subscribeToSignalChanges([currentApproval], check);
}
