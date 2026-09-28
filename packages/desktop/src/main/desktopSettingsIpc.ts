import { Effect, type Scope } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { SubscriptionDeviceCodePrompt } from '@auth/oauth/deviceAuthorization';
import { LoopbackTransportUnavailableError } from '@auth/oauth/loopbackLogin';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import {
  SETTINGS_LOG_CHANNEL,
  type SettingsHostBindings,
} from '@controllers/settingsView/settingsHostBindings';
import { createSettingsViewBody } from '@controllers/settingsView/sharedSettingsCommands';
import { onAppSignal } from '@eventBus/AppSignals';
import type { ExternalOpenFailed } from '@hosts/uiHosts';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import { unsupported } from '@shared/utils/dispatcher';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { gitHubTokenRejectedMessage } from '@tools/github/githubAuth';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { DesktopMessageHandler } from './desktopIpcTypes.js';
import type { DesktopSpawn } from './desktopWindows.js';

const NO_EXTENSION_HOSTING =
  'TeXRA Desktop runs standalone and cannot host VS Code extensions.';

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
    openSubscriptionSignInUrl(
      url: string,
    ): Effect.Effect<void, ExternalOpenFailed>;
    presentSubscriptionSignInUrl(
      url: string,
      productName: string,
    ): Effect.Effect<void, Error>;
    presentSubscriptionDeviceCode(
      prompt: SubscriptionDeviceCodePrompt,
      productName: string,
    ): Effect.Effect<void, Error>;
  };
  /** The TeXRA account behind the settings view's Sign in button. */
  readonly auth: {
    signIn(): Effect.Effect<void, Error>;
    signOut(): Effect.Effect<void, Error>;
  };
  /** The session of the paper this settings surface serves. The desktop has
   *  no process-default session, so it must be passed. */
  readonly session: SessionHandle;
  readonly secrets: PlatformSecrets;
  /** Root of the packaged resources tree, which holds the agent templates. */
  readonly resourcesPath: string;
  /** Runs this surface's background work on fibers of the scope it opens in. */
  readonly spawn: DesktopSpawn;
}

type SettingsViewBody = ReturnType<typeof createSettingsViewBody>;

export interface DesktopSettingsIpc
  extends
    DesktopMessageHandler,
    Pick<SettingsViewBody, 'refreshAfterAuthChange' | 'signInSubscription'> {}

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
  const { bindings, spawn, signInPresentation } = options;

  /**
   * Show one informational part of a sign-in without waiting for it: failing
   * to show a notice never aborts the sign-in it describes, and awaiting it
   * would block the approval poll or the OAuth callback wait. A failure is
   * reported in its own dialog, and a dialog that fails too is logged.
   */
  const presentInBackground = (
    displayName: string,
    present: Effect.Effect<void, Error>,
  ) => {
    spawn(
      present.pipe(
        Effect.catch((failure) =>
          bindings.notify.showErrorMessage(
            `Failed to display ${displayName} sign-in instructions: ${toErrorMessage(failure)}`,
          ),
        ),
        Effect.catchTag('NotificationFailed', (notice) =>
          Effect.logError(notice.message).pipe(
            withLogChannel(SETTINGS_LOG_CHANNEL),
          ),
        ),
      ),
    );
  };

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
        present: {
          presentDeviceCode: (prompt) =>
            presentInBackground(
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
                  new LoopbackTransportUnavailableError(
                    `Could not open a browser for ${displayName} sign-in.`,
                    { cause: failure.cause },
                  ),
              ),
              Effect.andThen(
                Effect.sync(() =>
                  presentInBackground(
                    displayName,
                    signInPresentation.presentSubscriptionSignInUrl(
                      url,
                      displayName,
                    ),
                  ),
                ),
              ),
            ),
        },
      });
      yield* provider.setPreferSubscription(options.session.roots, true);
      yield* bindings.notify.showInfoMessage(
        ACCOUNT_OUTCOME.signedInAs(displayName, account.label),
      );
    });
  };

  const body = createSettingsViewBody({
    host: 'desktop',
    session: options.session,
    secrets: options.secrets,
    resourcesPath: options.resourcesPath,
    skillDisplay: loadRuntimeSkillDisplay(
      options.session.roots.workspace,
      options.session.roots,
    ),
    accountCopy: ACCOUNT_OUTCOME,
    bindings: {
      ...bindings,
      signInSubscription,
    },
  });

  const registry: SettingsViewInboundHandlerRegistry<
    ProcessServices | StorageFs
  > = {
    ...body.handlers,
    // The settings view's Sign in button is a host entry.
    signIn: () => options.auth.signIn(),
    signOut: () => options.auth.signOut(),
    requestModelAccess: unsupported('Copilot models require VS Code.'),
    clearCopilotRoute: unsupported('Copilot models require VS Code.'),
    installToolExtension: unsupported(NO_EXTENSION_HOSTING),
    installLatexWorkshop: unsupported(NO_EXTENSION_HOSTING),
    applyLatexSettings: unsupported(
      'Recommended VS Code settings can only be applied from the TeXRA VS Code extension.',
    ),
  };

  const { repaintOn, settle } = body;
  const subscriptions: Array<Effect.Effect<void, never, ProcessServices>> = [
    body.followToolAvailability,
    ...(Object.keys(repaintOn) as Array<keyof typeof repaintOn>).map((signal) =>
      onAppSignal(signal, (payload) => {
        const work = repaintOn[signal](payload as never);
        if (work) spawn(settle(work));
      }),
    ),
    // Outside VS Code a rejected token left the pollers failing in silence.
    // The dialog is the whole fix: the token status reports only which store
    // holds a token, and rejection leaves the secret in place, so re-posting
    // it would repaint the same "token set" badge.
    onAppSignal('githubTokenInvalid', ({ message }) => {
      spawn(
        bindings.notify
          .showErrorMessage(gitHubTokenRejectedMessage(message))
          .pipe(
            Effect.catchTag('NotificationFailed', (notice) =>
              Effect.logError(notice.message).pipe(
                withLogChannel(SETTINGS_LOG_CHANNEL),
              ),
            ),
          ),
      );
    }),
  ];

  const settingsIpc: DesktopSettingsIpc = {
    refreshAfterAuthChange: body.refreshAfterAuthChange,
    signInSubscription: body.signInSubscription,
    handleMessage: (message) => body.handleMessage(message, registry),
  };
  return Effect.as(
    Effect.forEach(
      subscriptions,
      (subscription) =>
        Effect.forkScoped(subscription, { startImmediately: true }),
      { discard: true },
    ),
    settingsIpc,
  );
}
