// The window's onboarding cards' actions. The funnel state itself is each
// project's host snapshot's, which follows the flags and the credential.

import { Effect, FiberHandle, Scope } from 'effect';

import {
  AppState,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@texra-ai/harness/host';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import { kickoffDesktopSetup } from '@texra/controllers/onboarding/setupLaunch';
import {
  hostFailure,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';
import type { StateReadFailed, StateWriteFailed } from '@texra-ai/harness/host';
import type { DesktopProjectRegistry } from './desktopProjects.js';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';

/** The onboarding cards' actions the host request handlers call. */
export interface WindowOnboarding {
  /** The welcome card's skip: persists the declined flag. */
  skipOnboarding(): Effect.Effect<void, StateWriteFailed>;
  /** The setup card's skip: marks the first run done. */
  skipSetup(): Effect.Effect<void, StateWriteFailed>;
  /** The setup card's Run Setup: launches the setup conversation. */
  runSetup(): Effect.Effect<void>;
  signInWithChatGpt(): Effect.Effect<
    void,
    StateWriteFailed | StateReadFailed | HostFailed | RequestRefusal,
    ProcessServices
  >;
}

export const openWindowOnboarding = Effect.fn('desktop.openWindowOnboarding')(
  function* (options: {
    readonly runtime: ProcessRuntime;
    readonly projects: DesktopProjectRegistry;
    /** The settings surface and the launch path of the shown project, read
     *  when a card asks, since both are built after this surface. */
    readonly settings: () => DesktopSettingsIpc | undefined;
    readonly activeRun: () =>
      | Parameters<typeof kickoffDesktopSetup>[0]['run']
      | undefined;
  }): Effect.fn.Return<WindowOnboarding, never, Scope.Scope | AppState> {
    const { runtime, projects } = options;
    const state = yield* AppState;
    // One setup launch at a time: a double-click of "Run Setup" while the
    // first still resolves its model, before its run shows in the session
    // view the shared launch checks, is a no-op. The launch runs the setup
    // conversation to its end, past the card action that started it, and
    // stops with the window.
    const setupLaunch = yield* FiberHandle.make<void, never>();
    return {
      skipOnboarding: () => setOnboardingDeclined(state, true),
      skipSetup: () => setFirstRunDone(state),
      // The project and its launch path are read when the user clicks.
      runSetup: () =>
        Effect.asVoid(
          FiberHandle.run(
            setupLaunch,
            Effect.suspend(() =>
              withProcessServices(
                runtime,
                kickoffDesktopSetup({
                  project: projects.active(),
                  run: options.activeRun(),
                }),
              ),
            ),
            { onlyIfMissing: true },
          ),
        ),
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
        ),
    };
  },
);
