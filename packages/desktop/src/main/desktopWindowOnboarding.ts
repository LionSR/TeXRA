// The window's onboarding surface: the funnel, refreshed as the first-run
// flag changes, and the cards' actions.

import { Effect, Schema, Scope, SubscriptionRef } from 'effect';

import {
  AppState,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
  withLogChannel,
} from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { hasUsableSetupCredential } from '@texra/model/setupCredentialAccess';
import {
  followFirstRunDone,
  OnboardingFunnelRefresher,
  setFirstRunDone,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import { kickoffDesktopSetup } from '@texra/controllers/onboarding/setupLaunch';
import {
  hostFailure,
  type HostCallFailed,
} from '@texra/controllers/session/hostCallFailure';
import type { OnboardingFunnelState } from '@texra/shared/session/hostSnapshot';
import type { RequestRefusal } from '@texra-ai/harness';
import type { StateReadFailed, StateWriteFailed } from '@texra-ai/harness/host';
import type { DesktopProjectRegistry } from './desktopProjects.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';
import type { DesktopWindowHost } from './desktopWindowHost.js';

/**
 * The onboarding funnel of one window: the funnel state every open project's
 * `host` snapshot carries and the card actions the host request handlers
 * call.
 */
export interface WindowOnboarding {
  /** The funnel as last derived; null before the first refresh. */
  readonly funnel: SubscriptionRef.SubscriptionRef<OnboardingFunnelState | null>;
  /** Recompute the funnel from credentials + flags and publish it. */
  readonly refresh: Effect.Effect<void, StateWriteFailed | StateReadFailed>;
  /** The welcome card's skip: persists the declined flag and refreshes. */
  skipOnboarding(): Effect.Effect<void, StateWriteFailed | StateReadFailed>;
  /** The setup card's skip: marks the first run done, which the window's
   *  `followFirstRunDone` follower answers with a refresh. */
  skipSetup(): Effect.Effect<void, StateWriteFailed>;
  /** The setup card's Run Setup: launches the setup conversation. */
  runSetup(): Effect.Effect<void, StateWriteFailed | StateReadFailed>;
  signInWithChatGpt(): Effect.Effect<
    void,
    StateWriteFailed | StateReadFailed | HostCallFailed | RequestRefusal,
    ProcessServices
  >;
}

/**
 * The onboarding funnel could not be recomputed. The funnel is host state
 * every open project's snapshot carries, so a refresh that faults leaves the
 * last state in place and is reported, not swallowed. `reportAsyncError`
 * shows `toErrorMessage` of this failure, so the message is the rejection's
 * own text rather than an empty tail.
 */
class OnboardingRefreshFailed extends Schema.TaggedError<OnboardingRefreshFailed>()(
  'OnboardingRefreshFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const openWindowOnboarding = Effect.fn('desktop.openWindowOnboarding')(
  function* (options: {
    readonly host: DesktopWindowHost;
    readonly runtime: ProcessRuntime;
    readonly projects: DesktopProjectRegistry;
    /** The settings surface and the launch path of the shown project, read
     *  when a card asks, since both are built after this surface. */
    readonly settings: () => DesktopSettingsIpc | undefined;
    readonly activeRun: () =>
      Parameters<typeof kickoffDesktopSetup>[0]['run'] | undefined;
  }): Effect.fn.Return<
    {
      readonly onboarding: WindowOnboarding;
      /** Recompute the funnel on a fiber of the window's scope, so the
       *  caller does not wait on it; it reports its own failures. */
      readonly refreshFunnel: Effect.Effect<void>;
    },
    never,
    Scope.Scope | AppState
  > {
    const { host, runtime, projects } = options;
    const scope = yield* Scope.Scope;
    const state = yield* AppState;
    const funnelState =
      yield* SubscriptionRef.make<OnboardingFunnelState | null>(null);
    // This host's half of the shared funnel loop. Entering State 1 only paints
    // the setup card (the launcher's agent selection is the surface's), so the
    // `selectSetupAgent` case is deliberately discarded here as it is in the
    // CLI; the user launches setup explicitly via the card's "Run Setup"
    // button.
    const funnel = new OnboardingFunnelRefresher({
      // Single source of truth for "does the user have a usable
      // credential", shared by every host (extension, desktop, CLI) so this
      // credential-gating logic can't drift between them.
      hasCredential: () =>
        withProcessServices(
          runtime,
          hasUsableSetupCredential(projects.active().roots),
        ).pipe(withLogChannel('Setup Credentials')),
      flags: state,
      apply: (transition) => SubscriptionRef.set(funnelState, transition.state),
    });
    const refresh = funnel.run();

    let setupKickoffStarted = false;
    const onboarding: WindowOnboarding = {
      funnel: funnelState,
      refresh,
      skipOnboarding: () =>
        setOnboardingDeclined(state, true).pipe(Effect.andThen(refresh)),
      skipSetup: () => setFirstRunDone(state),
      // The guard keeps a double-click of "Run Setup" from launching a second
      // concurrent run while the first still resolves its model, before its
      // run shows in the session view the shared launch checks.
      runSetup: Effect.fn('runSetup')(function* () {
        if (!setupKickoffStarted) {
          setupKickoffStarted = true;
          // Fire-and-forget: the kickoff runs the setup conversation to
          // completion, which must NOT block the serialized funnel-refresh
          // chain — otherwise a later "skip setup" / sign-out /
          // credential-removal refresh would queue behind the entire setup
          // run, leaving the card stuck on 'setup'. Detached, so the run
          // outlives the card action that started it. The project and its
          // launch path are read now, when the user clicks.
          yield* Effect.suspend(() =>
            withProcessServices(
              runtime,
              kickoffDesktopSetup({
                project: projects.active(),
                run: options.activeRun(),
              }),
            ),
          ).pipe(
            // Clear the guard once the run finishes (success or failure):
            // while it's in flight the guard blocks a concurrent second
            // run, but afterwards another manual "Run Setup" click must
            // launch again.
            Effect.ensuring(
              Effect.sync(() => {
                setupKickoffStarted = false;
              }),
            ),
            Effect.forkDetach,
          );
        }
        return yield* refresh;
      }),
      // Suspended so the "settings IPC not attached" guard raises when the
      // card's program runs, not when it is built.
      signInWithChatGpt: () =>
        Effect.suspend(() => {
          const settings = options.settings();
          if (!settings) {
            throw new Error('Desktop settings IPC is not attached.');
          }
          return settings.signInSubscription('chatgpt');
        }).pipe(
          Effect.mapError((cause) =>
            hostFailure('onboarding.signInWithChatGpt', cause),
          ),
          Effect.andThen(refresh),
        ),
    };
    const refreshFunnel: Effect.Effect<void> = Effect.suspend(() =>
      withProcessServices(runtime, refresh).pipe(
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
    yield* Effect.forkIn(followFirstRunDone(refreshFunnel), scope);
    return { onboarding, refreshFunnel };
  },
);
