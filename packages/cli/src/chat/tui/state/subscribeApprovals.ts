// TUI side of the request protocol.
//
// A run asks a person with `request.opened`; the fold lists it in
// `view.requests` until a `request.decided` answers it, and the modal reads
// that list (`approvalQueue.ts`). This module owns only what a request needs
// before it can be shown or answered on this host: a tool edit's preview and
// the `useOwnApiKey` capability a retry decision names, whose key entry and
// decision are `ProgressApiKeyRetryController`'s, shared with the extension
// and desktop.
//
// The attached host answers nothing on its own: it stages each listed tool
// edit's preview for the modal, and presents events.

import { Cause, Effect, Exit, FiberSet, Scope } from 'effect';

import {
  type HostInteractions,
  type ProcessRuntime,
} from '@texra-ai/harness/host';
import { withLogChannel, type SettingsStores } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { promptForCliProviderApiKey } from '@cli/chat/tui/hosts/cliProviderKeys';
import type { CliContext } from '@cli/runtime/platform/cliContext';
import type { CliRuntimeHost } from '@cli/runtime/headless/cliPresentationHost';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { followToolEditPreviews } from '@texra/controllers/approval/ToolEditApprovalController';
import {
  ApiKeyPromptFailed,
  ProgressApiKeyRetryController,
} from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { requestErrorText } from '@ui/copy/requestErrors';

import { notify } from '../notifications/terminalNotifier';
import {
  attentionRequests,
  currentApproval,
  dropPresentation,
  pruneToLive,
  reopenRequest,
  stagePresentation,
} from './approvalQueue';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
  reportRequestDefect,
} from './transcript';
import type { Session } from '@texra-ai/harness';
import { isRequestRefusal } from '@texra/controllers/session/hostCallFailure';

/**
 * What this host holds for its lifetime: the session its denial notices read
 * the policy from and its decisions land on, the settings slots a retry's
 * key prompt goes through, and the runtime its work is forked on, which
 * serves the secret store that prompt writes. All three come from the chat
 * session's caller, which holds them already.
 */
interface TuiApprovalStores {
  /** Where its decisions land and its pending requests are read: the
   *  chat's session, here or in the service. */
  readonly requests: Pick<Session, 'request'> & {
    readonly view: Pick<Session['view'], 'changes' | 'current'>;
  };
  /** The settings slots a key prompt reads a provider's display name and key
   *  URL from, so a retry that has to ask for a credential words the ask the
   *  same way `/key` does. */
  readonly settings: SettingsStores;
  /** The process runtime this attachment's work is forked on, held for the
   *  host's lifetime rather than looked up per decision. */
  readonly runtime: ProcessRuntime;
}

/** The TUI's presentation host, and the host commands it performs for the
 *  chat's decisions while it is attached. */
export interface TuiHostInteractions extends HostInteractions {
  readonly performHost: (command: HostCommand) => void;
}

/** Create the TUI's presentation host. */
export function createTuiHostInteractions(
  host: CliRuntimeHost,
  context: CliContext,
  stores: TuiApprovalStores,
): TuiHostInteractions {
  const apiKeyRetry = new ProgressApiKeyRetryController({
    promptForApiKey: (provider) =>
      promptForCliProviderApiKey(stores.settings, provider).pipe(
        Effect.mapError(
          (cause) =>
            new ApiKeyPromptFailed({
              provider,
              message: toErrorMessage(cause),
              cause,
            }),
        ),
      ),
    session: stores.requests,
  });
  /** The attachment's lifetime: the pending-request follower and the
   *  own-key switches in flight. An attachment that is gone answers for
   *  nobody, so `dispose` closes it, interrupting the switches before they
   *  decide a request the next owner will. */
  const attached = stores.runtime.runSync(Scope.make());
  const switches = stores.runtime.runSync(
    FiberSet.make<void>().pipe(Effect.provideService(Scope.Scope, attached)),
  );

  /**
   * A retry on the user's own key, through the shared controller. A switch
   * that did not happen leaves the retry pending, as on every other host:
   * the card comes back with the reason worded into the conversation, and
   * the user picks again.
   */
  const useOwnApiKey = (
    request: Extract<HostCommand, { kind: 'useOwnApiKey' }>,
  ): void => {
    const { runId, requestId } = request;
    stores.runtime.runFork(
      FiberSet.run(
        switches,
        apiKeyRetry.useOwnApiKey(request).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Retry ${requestId} stays pending: ${toErrorMessage(error)}`,
            ).pipe(
              withLogChannel('cli.tui'),
              Effect.andThen(
                Effect.sync(() => {
                  reopenRequest(requestId);
                  appendLocalNotice(
                    isRequestRefusal(error)
                      ? requestErrorText(error)
                      : toErrorMessage(error),
                    runId,
                  );
                }),
              ),
            ),
          ),
          // An interruption is this attachment leaving, not a failure.
          Effect.catchDefect((defect) =>
            Effect.map(reportRequestDefect(Cause.die(defect)), (message) => {
              reopenRequest(requestId);
              appendLocalErrorTranscript(message, runId);
            }),
          ),
        ),
      ),
    );
  };

  const performHost = (arm: HostCommand): void => {
    if (arm.kind === 'useOwnApiKey') {
      useOwnApiKey(arm);
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
   * Stage each listed tool edit's card with its preview until the view
   * drops it. The session decided everything its policy settles before the
   * request was listed, so what is listed waits for a person. A preview
   * that could not be read is said on the card itself.
   */
  stores.runtime.runFork(
    Effect.forkIn(
      followToolEditPreviews(stores.requests, ({ payload, requestId }, tui) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            stagePresentation({ kind: 'toolEdit', data: payload.data, tui }),
          ),
          () => dropPresentation(requestId),
        ),
      ),
      attached,
    ),
  );
  return {
    performHost,
    // The CLI host renders the notice itself and says whether it rendered a
    // user-visible record; there is no program for the session to fork.
    emit: (event, payload) => {
      host.emit(event, payload);
    },
    dispose() {
      stores.runtime.runFork(Scope.close(attached, Exit.void));
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
