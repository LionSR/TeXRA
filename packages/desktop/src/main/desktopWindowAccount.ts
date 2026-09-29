// The window's account surfaces: the sign-in the login banner, the settings
// rows and the native menu share, and the onboarding funnel a session change
// or a settled launch recomputes.

import { dialog } from 'electron';
import { Data, Effect, Scope } from 'effect';

import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import type { PendingOAuthStore } from '@controllers/auth/pendingOAuthStore';
import { withLogChannel } from '@logger/effectLog';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import type {
  StateReadFailed,
  StateStore,
  StateWriteFailed,
} from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { kickoffDesktopSetup } from './desktopAgentLaunch.js';
import { chooseDesktopOAuthProvider } from './desktopOAuthProviderPrompt.js';
import { createDesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import { createDesktopSupabaseAuth } from './desktopSupabaseAuth.js';
import type { DesktopAgentRun } from './desktopAgentRun.js';
import type { DesktopProjectRegistry } from './desktopProjects.js';
import type { DesktopProtocolCallbackRouter } from './desktopProtocolCallbacks.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';

/**
 * The onboarding funnel could not be recomputed. The funnel is host state
 * every open project's snapshot carries, so a refresh that faults leaves the
 * last state in place and is reported, not swallowed. `reportAsyncError`
 * shows `toErrorMessage` of this failure, so the message is the rejection's
 * own text rather than an empty tail.
 */
class OnboardingRefreshFailed extends Data.TaggedError(
  'OnboardingRefreshFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export const openWindowAccount = Effect.fn('desktop.openWindowAccount')(
  function* (options: {
    readonly host: DesktopWindowHost;
    readonly runtime: ProcessRuntime;
    readonly projects: DesktopProjectRegistry;
    readonly supabaseAuth: SupabaseAuthShape;
    /** The pending sign-in records, opened before the window so a deep link
     *  that launched the app can still be claimed. */
    readonly pendingOAuthStore: PendingOAuthStore;
    readonly protocolRouter: DesktopProtocolCallbackRouter;
    readonly globalState: StateStore;
    readonly secrets: PlatformSecrets;
    /** The settings surface and the launch path of the shown project, read
     *  when an account change or a card asks, since both are built after
     *  this surface. */
    readonly settings: () => DesktopSettingsIpc | undefined;
    readonly activeRun: () => Pick<DesktopAgentRun, 'runValidated'> | undefined;
  }): Effect.fn.Return<
    {
      readonly onboarding: ReturnType<typeof createDesktopOnboardingIpc>;
      readonly signIn: () => Effect.Effect<void, Error>;
      readonly signOut: () => Effect.Effect<void, Error>;
      /** Recompute the funnel on a fiber of the window's scope, so a launch
       *  settles without waiting on it; it reports its own failures. */
      readonly refreshFunnelAfterLaunch: Effect.Effect<void>;
    },
    never,
    Scope.Scope
  > {
    const { host, runtime, projects } = options;
    const scope = yield* Scope.Scope;
    const desktopAuth = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createDesktopSupabaseAuth({
          router: options.protocolRouter,
          auth: options.supabaseAuth,
          store: options.pendingOAuthStore,
          host: {
            openExternalUrl: (url) =>
              host.previewHost.openExternal(url, { reportFailure: false }),
            showInfoMessage: host.dialogs.showInfoMessage,
            showErrorMessage: host.dialogs.showErrorMessage,
            // Every surface an account change touches, as one program: the
            // settings view, then the onboarding funnel.
            onSessionChanged: () =>
              Effect.gen(function* () {
                yield* options.settings()?.refreshAfterAuthChange() ??
                  Effect.void;
                yield* onboarding.refreshOnboardingFunnel();
              }),
          },
          runtime,
        }),
      ),
      // Closing the window unsubscribes it from the protocol router and
      // nothing more: a sign-in still completing in the browser keeps its
      // pending record for the next window's coordinator.
      (auth) => Effect.sync(() => auth.dispose()),
    );
    /**
     * Sole owner of the desktop sign-in provider choice. Every sign-in entry
     * point (login banner, credential settings) routes here so the desktop
     * offers the same providers as the extension quick pick and the CLI
     * select instead of assuming one account type.
     */
    const signIn = (): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const provider = yield* Effect.tryPromise({
          try: () =>
            chooseDesktopOAuthProvider((messageBoxOptions) =>
              dialog.showMessageBox(host.window, messageBoxOptions),
            ),
          catch: ensureError,
        });
        if (provider === undefined) return;
        yield* desktopAuth.signIn(provider);
      });

    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer: host.post },
      {
        state: options.globalState,
        // Single source of truth for "does the user have a usable
        // credential", shared by every host (extension, desktop, CLI) so this
        // credential-gating logic can't drift between them.
        hasCredential: () =>
          hasUsableSetupCredential(
            projects.active().session.roots,
            options.secrets,
          ).pipe(withLogChannel('Setup Credentials')),
        // Suspended so the project and its launch path are read when the user
        // clicks "Run Setup", not when the port is built. The per-session
        // `setupKickoffStarted` dedup guard inside the onboarding IPC keeps
        // this one-shot.
        kickoffSetup: () =>
          Effect.suspend(() =>
            kickoffDesktopSetup({
              session: projects.active().session,
              run: options.activeRun(),
              secrets: options.secrets,
              runtime,
            }),
          ),
        // Suspended so the "settings IPC not attached" guard raises when the
        // card's program runs, not when the port is built.
        signInWithChatGpt: () =>
          Effect.suspend(() => {
            const settings = options.settings();
            if (!settings) {
              throw new Error('Desktop settings IPC is not attached.');
            }
            return settings.signInSubscription('chatgpt');
          }),
      },
    );
    const refreshFunnelAfterLaunch: Effect.Effect<void> = Effect.suspend(() =>
      withProcessServices(runtime, onboarding.refreshOnboardingFunnel()).pipe(
        Effect.catch((error: StateWriteFailed | StateReadFailed) =>
          Effect.sync(() =>
            host.reportAsyncError(
              new OnboardingRefreshFailed({
                message: `The onboarding state could not be refreshed: ${toErrorMessage(error)}`,
                cause: error,
              }),
            ),
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.sync(() => host.reportAsyncError(defect)),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      ),
    );
    return {
      onboarding,
      signIn,
      signOut: () => desktopAuth.signOut(),
      refreshFunnelAfterLaunch,
    };
  },
);
