import { Effect, type Scope } from 'effect';

import {
  LoopbackTransportUnavailableError,
  type SubscriptionDeviceCodePrompt,
} from '@texra-ai/llm/node';
import type { SessionHandle } from '@agent/runtime';
import { onAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs } from '@platform/rootedFs';
import { ACCOUNT_OUTCOME } from '@shared/model/accountAuth';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { unsupported } from '@texra/shared/utils/dispatcher';
import type { ExternalOpenFailed } from '@texra/hosts/uiHosts';
import { SettingsViewInboundMessageSchema } from '@texra/shared/settingsView/settingsViewMessages';
import { createSettingsViewBody } from '@texra/controllers/settingsView/sharedSettingsCommands';
import {
  SETTINGS_LOG_CHANNEL,
  type SettingsHostBindings,
} from '@texra/controllers/settingsView/settingsHostBindings';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { gitHubTokenRejectedMessage } from '@texra/tools/github/githubAuth';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { parsedRoute, type DesktopCommandRoute } from './desktopIpcTypes.js';
import type { PlatformSecrets } from '@texra-ai/harness';
import type { DesktopSpawn } from './desktopWindows.js';

const NO_EXTENSION_HOSTING =
  'TeXRA Desktop runs standalone and cannot host VS Code extensions.';

/** Each project's policy updates to the service, one at a time. */
const policyLanes = new WeakMap<SessionBackend, PerKeyLane>();

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
  /** The session of the project this settings surface serves. The desktop has
   *  no process-default session, so it must be passed. */
  readonly session: SessionHandle;
  /** Where the project's runs run: an approval policy set here applies
   *  there too. */
  readonly backend: SessionBackend;
  readonly secrets: PlatformSecrets;
  /** Root of the packaged resources tree, which holds the agent templates. */
  readonly resourcesPath: string;
  /** Runs this surface's background work on fibers of the scope it opens in. */
  readonly spawn: DesktopSpawn;
}

type SettingsViewBody = ReturnType<typeof createSettingsViewBody>;

/** The commands the settings view posts to its host. */
export const SETTINGS_VIEW_INBOUND_COMMANDS =
  SettingsViewInboundMessageSchema.options.flatMap((option) => [
    ...option.shape.command.values,
  ]);

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
        bindings.notify.showErrorMessage(
          `Failed to display ${displayName} sign-in instructions: ${toErrorMessage(failure)}`,
        ),
      ),
      Effect.catchTag('NotificationFailed', (notice) =>
        Effect.logError(notice.message).pipe(
          withLogChannel(SETTINGS_LOG_CHANNEL),
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
      yield* provider.setPreferSubscription(options.session.roots, true);
      yield* bindings.notify.showInfoMessage(
        ACCOUNT_OUTCOME.signedInAs(displayName, account.label),
      );
    });
  };

  const body = createSettingsViewBody({
    host: 'desktop',
    session: {
      roots: options.session.roots,
      // The policy holds here and in the service that runs the project's
      // tasks. Telling the service outlives this surface, in the order set:
      // a project switch or a closed window must not leave the service on
      // an older policy.
      setApprovalPolicy: (policy) => {
        options.session.setApprovalPolicy(policy);
        spawn(
          Effect.asVoid(
            Effect.forkDetach(
              options.backend
                .setApprovalPolicy(policy)
                .pipe(withPerKeyLane(policyLanes, options.backend)),
            ),
          ),
        );
      },
    },
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
    signInSubscription: body.signInSubscription,
    route: parsedRoute(SettingsViewInboundMessageSchema, (message) =>
      body.handleMessage(message, registry),
    ),
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
