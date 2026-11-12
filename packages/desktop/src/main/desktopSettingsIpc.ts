import { Effect, type Scope } from 'effect';

import {
  LoopbackTransportUnavailableError,
  type SubscriptionDeviceCodePrompt,
} from '@texra-ai/llm/node';
import { Skills } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { onAppSignal } from '@texra-ai/harness/host';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { SettingsViewInboundMessageSchema } from '@texra/shared/settingsView/settingsViewMessages';
import { makeSettingsViewBody } from '@texra/controllers/settingsView/settingsViewBody';
import type { SettingsHostBindings } from '@texra/controllers/settingsView/settingsHostBindings';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { gitHubTokenRejectedMessage } from '@texra/tools/github/githubAuth';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { parsedRoute, type DesktopCommandRoute } from './desktopIpcTypes.js';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessServices } from '@texra-ai/harness/host';
import type { DesktopSpawn } from './desktopWindows.js';

export interface DesktopSettingsIpcOptions {
  /** This window's half of the shared settings body; the subscription
   *  sign-in is built here. */
  readonly bindings: Omit<SettingsHostBindings, 'signInSubscription'>;
  /** How a subscription sign-in reaches the user: the loopback browser, and
   *  the device code shown when no browser can carry the callback. */
  readonly signInPresentation: {
    /** Fails rather than raising the window's own "could not open" dialog:
     *  the sign-in reports a missing browser itself and falls back to a
     *  device code. */
    openSubscriptionSignInUrl(url: string): Effect.Effect<void, HostFailed>;
    presentSubscriptionSignInUrl(
      url: string,
      productName: string,
    ): Effect.Effect<void, Error>;
    presentSubscriptionDeviceCode(
      prompt: SubscriptionDeviceCodePrompt,
      productName: string,
    ): Effect.Effect<void, Error>;
  };
  /** The roots of the project this settings surface serves. The desktop has
   *  no process-default roots, so they must be passed. */
  readonly roots: WorkspaceRoots;
  /** Root of the packaged resources tree, which holds the agent templates. */
  readonly resourcesPath: string;
  /** Runs this surface's background work on fibers of the scope it opens in. */
  readonly spawn: DesktopSpawn;
}

type SettingsViewBody = Effect.Success<ReturnType<typeof makeSettingsViewBody>>;

/** The commands the settings view posts to its host. */
export const SETTINGS_VIEW_INBOUND_COMMANDS =
  SettingsViewInboundMessageSchema.members.map(
    (member) => member.fields.command.literal,
  );

export interface DesktopSettingsIpc extends Pick<
  SettingsViewBody,
  'signInSubscription'
> {
  /** The one route every inbound settings command runs. */
  readonly route: DesktopCommandRoute;
}

/**
 * The settings surface of one project, with its app-signal subscriptions
 * forked into the caller's scope. They belong to the window's project
 * binding, not to the process: the window opens again on macOS dock
 * reactivation, so a listener that outlived its scope would post to a
 * destroyed window's renderer and, for `githubTokenInvalid`, raise a dialog
 * against a `BrowserWindow` that no longer exists.
 */
export function createDesktopSettingsIpc(
  options: DesktopSettingsIpcOptions,
): Effect.Effect<DesktopSettingsIpc, never, Scope.Scope | ProcessServices> {
  return Effect.gen(function* () {
    const { bindings, spawn, signInPresentation } = options;

    /**
     * Show one informational part of a sign-in, reporting a failure in its own
     * dialog and a dialog that fails too in the log: failing to show a notice
     * never aborts the sign-in it describes. The caller decides whether the flow
     * waits for it, which it must not for a part that blocks until the user acts.
     */
    const reportPresentation = (
      displayName: string,
      present: Effect.Effect<void, Error>,
    ) =>
      present.pipe(
        Effect.catch((failure) =>
          bindings.dialogs.notify(
            'error',
            `Failed to display ${displayName} sign-in instructions: ${toErrorMessage(failure)}`,
          ),
        ),
      );

    /**
     * The loopback browser is the normal route; failing to reach one is a
     * transport failure, so the shared flow retries with a device code, which
     * this window shows in its own dialog.
     */
    const signInSubscription = (providerId: SubscriptionProviderId) => {
      const provider = subscriptionProvider(providerId);
      const { displayName } = provider;
      return Effect.gen(function* () {
        const account = yield* provider.signIn({
          transport: 'auto',
          stores: options.roots,
          present: {
            presentDeviceCode: (prompt) =>
              reportPresentation(
                displayName,
                signInPresentation.presentSubscriptionDeviceCode(
                  prompt,
                  displayName,
                ),
              ),
            presentSignInUrl: (url) =>
              signInPresentation.openSubscriptionSignInUrl(url).pipe(
                Effect.mapError(
                  (failure) =>
                    new LoopbackTransportUnavailableError({
                      message: `Could not open a browser for ${displayName} sign-in.`,
                      cause: failure.cause,
                    }),
                ),
                Effect.andThen(
                  Effect.sync(() =>
                    spawn(
                      reportPresentation(
                        displayName,
                        signInPresentation.presentSubscriptionSignInUrl(
                          url,
                          displayName,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          },
        });
        yield* bindings.dialogs.notify(
          'info',
          ACCOUNT_OUTCOME.signedInAs(displayName, account.label),
        );
      });
    };

    const body = yield* makeSettingsViewBody({
      // The approval policy is the project's persisted setting: the write
      // is the change, which this session and the service both read.
      roots: options.roots,
      resourcesPath: options.resourcesPath,
      skillDisplay: Skills.display(options.roots),
      accountCopy: ACCOUNT_OUTCOME,
      bindings: {
        ...bindings,
        signInSubscription,
      },
    });

    const subscriptions: Array<Effect.Effect<void, never, ProcessServices>> = [
      body.follow,
      // Outside VS Code a rejected token left the pollers failing in silence.
      // The dialog is the whole fix: the token status reports only which store
      // holds a token, and rejection leaves the secret in place, so re-posting
      // it would repaint the same "token set" badge.
      onAppSignal('githubTokenInvalid', ({ message }) => {
        spawn(
          bindings.dialogs.notify('error', gitHubTokenRejectedMessage(message)),
        );
      }),
    ];

    const settingsIpc: DesktopSettingsIpc = {
      signInSubscription: body.signInSubscription,
      route: parsedRoute(SettingsViewInboundMessageSchema, (message) =>
        body.handleMessage(message),
      ),
    };
    yield* Effect.forEach(
      subscriptions,
      (subscription) =>
        Effect.forkScoped(subscription, { startImmediately: true }),
      { discard: true },
    );
    return settingsIpc;
  });
}
