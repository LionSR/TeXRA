import { Effect, type Scope } from 'effect';

import type { SubscriptionDeviceCodePrompt } from '@texra-ai/llm/node';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { SettingsViewInboundMessageSchema } from '@texra/shared/settingsView/settingsViewMessages';
import { makeSettingsViewBody } from '@texra/controllers/settingsView/settingsViewBody';
import type { SettingsHostBindings } from '@texra/controllers/settingsView/settingsHostBindings';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
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
  /** Runs this surface's background work on fibers of the scope it opens in. */
  readonly spawn: DesktopSpawn;
}

type SettingsViewBody = Effect.Success<ReturnType<typeof makeSettingsViewBody>>;

/** The commands the settings view posts to its host. */
export const SETTINGS_VIEW_INBOUND_COMMANDS = Object.freeze(
  SettingsViewInboundMessageSchema.members.map(
    (member) => member.fields.command.literal,
  ),
);

export interface DesktopSettingsIpc extends Pick<
  SettingsViewBody,
  'signInSubscription'
> {
  /** The one route every inbound settings command runs. */
  readonly route: DesktopCommandRoute;
}

/**
 * The settings surface of one project, with the body's follower forked into
 * the caller's scope. It belongs to the window's project binding, not to the
 * process: the window opens again on macOS dock reactivation, so a follower
 * that outlived its scope would post to a destroyed window's renderer.
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
     * The loopback browser is the normal route; the shared flow retries with
     * a device code when the browser could not be opened, which this window
     * shows in its own dialog.
     */
    const signInSubscription = (providerId: SubscriptionProviderId) => {
      const provider = subscriptionProvider(providerId);
      const { displayName } = provider;
      return provider.signIn({
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
            signInPresentation
              .openSubscriptionSignInUrl(url)
              .pipe(
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
    };

    const body = yield* makeSettingsViewBody({
      // The approval policy is the project's persisted setting: the write
      // is the change, which this session and the service both read.
      roots: options.roots,
      bindings: {
        ...bindings,
        signInSubscription,
      },
    });

    const settingsIpc: DesktopSettingsIpc = {
      signInSubscription: body.signInSubscription,
      route: parsedRoute(SettingsViewInboundMessageSchema, (message) =>
        body.handleMessage(message),
      ),
    };
    yield* Effect.forkScoped(body.follow, { startImmediately: true });
    return settingsIpc;
  });
}
