// The window's onboarding surface: the funnel a settled launch recomputes and
// the cards' actions.

import { Data, Effect, Scope } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { kickoffDesktopSetup } from './desktopAgentLaunch.js';
import { createDesktopOnboardingIpc } from './desktopOnboardingIpc.js';
import type {
  PlatformSecrets,
  StateReadFailed,
  StateStore,
  StateWriteFailed,
} from '@texra-ai/harness';
import type { DesktopAgentRun } from './desktopAgentRun.js';
import type { DesktopProjectRegistry } from './desktopProjects.js';
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

export const openWindowOnboarding = Effect.fn('desktop.openWindowOnboarding')(
  function* (options: {
    readonly host: DesktopWindowHost;
    readonly runtime: ProcessRuntime;
    readonly projects: DesktopProjectRegistry;
    readonly globalState: StateStore;
    readonly secrets: PlatformSecrets;
    /** The settings surface and the launch path of the shown project, read
     *  when a card asks, since both are built after this surface. */
    readonly settings: () => DesktopSettingsIpc | undefined;
    readonly activeRun: () => Pick<DesktopAgentRun, 'runValidated'> | undefined;
  }): Effect.fn.Return<
    {
      readonly onboarding: ReturnType<typeof createDesktopOnboardingIpc>;
      /** Recompute the funnel on a fiber of the window's scope, so a launch
       *  settles without waiting on it; it reports its own failures. */
      readonly refreshFunnelAfterLaunch: Effect.Effect<void>;
    },
    never,
    Scope.Scope
  > {
    const { host, runtime, projects } = options;
    const scope = yield* Scope.Scope;
    const onboarding = createDesktopOnboardingIpc({
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
    });
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
      refreshFunnelAfterLaunch,
    };
  },
);
