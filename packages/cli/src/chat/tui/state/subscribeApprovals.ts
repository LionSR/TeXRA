// TUI side of the request protocol.
//
// A run asks a person with `request.opened`; the session view lists it in
// `view.requests` until a `request.decided` answers it, and the modal reads
// that list (`approvalQueue.ts`). This module owns only what a request needs
// before it can be shown or answered on this host: a tool edit's preview and
// the `useOwnApiKey` capability a retry decision names, whose key entry and
// decision are `ProgressApiKeyRetryController`'s, shared with the extension
// and desktop.
//
// The attached host answers nothing on its own: it stages each listed tool
// edit's preview for the modal, and presents events as transcript rows.

import { Cause, Effect } from 'effect';

import type {
  HostInteractions,
  PresentationEventHandlers,
  RuntimePresentationEventPayloads,
} from '@texra-ai/harness/host';
import { withLogChannel, type SettingsStores } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { tuiUi } from '@cli/chat/tui/hosts/tuiUiHost';
import { setProviderKey } from '@texra/controllers/settingsView/providerKeyActions';
import { missingAgentMessage } from '@cli/runtime/agents';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import { followToolEditPreviews } from '@texra/controllers/approval/ToolEditApprovalController';
import {
  ApiKeyPromptFailed,
  ProgressApiKeyRetryController,
} from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { requestErrorText } from '@ui/copy/requestErrors';
import {
  formatInstructionActionHint,
  instructionActions,
} from '@ui/copy/instructionActions';
import { shownFailureText } from '@ui/copy/modelAccess';

import { notify } from '../notifications/terminalNotifier';
import { runAttentionLine, runStatusLabel } from '@ui/copy/runStatus';
import { currentView, runViewOf } from './sessionView';
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
import type { ScopeRunner } from '../../scopeRunner';

/**
 * What this host holds for its lifetime: the session its denial notices read
 * the policy from and its decisions land on, the settings slots a retry's
 * key prompt goes through, and the chat's runner, under which its own work
 * runs. All three come from the chat session's caller, which holds them
 * already.
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
  /** The chat's runner: this attachment's work runs in a scope under the
   *  chat's, which ends with `dispose` or with the chat. */
  readonly chat: ScopeRunner;
}

/** The TUI's presentation host, and the host commands it performs for the
 *  chat's decisions while it is attached. */
interface TuiHostInteractions extends HostInteractions {
  readonly performHost: (command: HostCommand) => void;
}

/**
 * Where the chat shows a notice: as a transcript row, where the person is
 * reading. Ink owns the terminal while the chat runs, so nothing here writes
 * stdout or stderr. A file the session asks to open has no terminal view.
 */
export const presentInTranscript: PresentationEventHandlers<RuntimePresentationEventPayloads> =
  Object.freeze({
    requestShowError: (payload) =>
      appendLocalErrorTranscript(shownFailureText(payload)),
    requestShowInstruction: ({ key, message }) =>
      appendLocalNotice(
        `${message}${formatInstructionActionHint(instructionActions(key))}`,
      ),
    openFile: () => undefined,
    agentNotFound: ({ agentName }) =>
      appendLocalErrorTranscript(missingAgentMessage(agentName)),
  });

/** Create the TUI's presentation host. */
export function createTuiHostInteractions(
  stores: TuiApprovalStores,
): TuiHostInteractions {
  const apiKeyRetry = new ProgressApiKeyRetryController({
    // A dismissed prompt is the answer "no key", not a failure: the retry
    // controller re-reads the store and says the retry did not switch.
    promptForApiKey: (provider) =>
      setProviderKey(tuiUi, stores.settings, provider).pipe(
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
  const attached = stores.chat.child();

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
    attached.fork(
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
    );
  };

  const performHost = (command: HostCommand): void => {
    if (command.kind === 'useOwnApiKey') {
      useOwnApiKey(command);
      return;
    }
    // Every other capability belongs to a windowed host's surfaces; no TUI
    // action names one, so reaching here is a defect.
    attached.fork(
      Effect.logWarning(
        `The TUI does not perform the ${command.kind} host capability.`,
      ).pipe(withLogChannel('cli.tui')),
    );
  };

  /**
   * Stage each listed tool edit's card with its preview until the view
   * drops it. The session decided everything its policy decides before the
   * request was listed, so what is listed waits for a person. A preview
   * that could not be read is said on the card itself.
   */
  attached.fork(
    followToolEditPreviews(stores.requests, ({ payload, requestId }, tui) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          stagePresentation({ kind: 'toolEdit', data: payload.data, tui }),
        ),
        () => dropPresentation(requestId),
      ),
    ),
  );
  return {
    performHost,
    // Rendered here, synchronously: there is no program for the session
    // to fork.
    emit: (event, payload) => {
      presentInTranscript[event](payload);
    },
    dispose: attached.close,
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
    // A decided request is never presented again, so its entry leaves too.
    pruneToLive(
      new Set(attentionRequests.get().map((request) => request.requestId)),
      announced,
    );
    const { requestId: id, runId } = pending.payload.data;
    if (announced.has(id)) return;
    announced.add(id);
    const run = runViewOf(currentView(), runId);
    // A request whose run the view does not hold yet still rings, unnamed.
    notify(
      run === undefined
        ? runStatusLabel('waitingOnUser')
        : runAttentionLine(run, 'waitingOnUser'),
    );
  };
  check();
  return subscribeToSignalChanges([currentApproval], check);
}
