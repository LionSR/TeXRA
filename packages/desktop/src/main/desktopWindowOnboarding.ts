// The window's onboarding cards' actions. The funnel state itself is each
// project's host snapshot's, which follows the flags and the credential.

import { Effect, FiberHandle, Scope } from 'effect';

import {
  presentRunFailure,
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@texra-ai/harness/host';
import type { Secrets } from '@texra-ai/harness/plugins';
import { Cancelled } from '@texra-ai/harness/schemas';
import {
  launchSetup,
  type WindowSetupLaunch,
} from '@texra/controllers/onboarding/setupLaunch';
import {
  hostFailure,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';
import type { HostFailed } from '@texra/hosts/uiHosts';
import type { StateReadFailed, StateWriteFailed } from '@texra-ai/harness/host';
import type { DesktopSettingsIpc } from './desktopSettingsIpc.js';

/**
 * Launch the setup conversation from the setup card through the launch path
 * of the window that asked, the one its Execute button uses. Setup continues
 * after its initiating request has completed, so a failure before the launch
 * is presented here (the launch path presents its own); the kickoff finishes
 * with the setup run, so a second Run Setup waits for it. A setup run already
 * live in the project is left to run alone.
 */
const kickoffSetup = (
  launch: WindowSetupLaunch,
): Effect.Effect<void, never, Secrets | ProcessServices> =>
  launchSetup({
    session: launch.session,
    roots: launch.roots,
    start: launch.runValidated,
  }).pipe(
    Effect.catchTag('SetupAlreadyRunning', () => Effect.void),
    Effect.catch((error) =>
      error instanceof Cancelled
        ? Effect.void
        : presentRunFailure(launch.present, error),
    ),
  );

/** The onboarding cards' actions the host request handlers call. */
export interface WindowOnboarding {
  /** The setup card's Run Setup: launches the setup conversation through
   *  the launch path of the project window that asked. */
  runSetup(launch: WindowSetupLaunch): Effect.Effect<void>;
  signInWithChatGpt(): Effect.Effect<
    void,
    StateWriteFailed | StateReadFailed | HostFailed | RequestRefusal,
    ProcessServices
  >;
}

export const openWindowOnboarding = Effect.fn('desktop.openWindowOnboarding')(
  function* (options: {
    readonly runtime: ProcessRuntime;
    /** The settings surface, read when a card asks, since it is built after
     *  this surface. */
    readonly settings: () => DesktopSettingsIpc | undefined;
  }): Effect.fn.Return<WindowOnboarding, never, Scope.Scope> {
    const { runtime } = options;
    // One setup launch at a time: a double-click of "Run Setup" while the
    // first still resolves its model, before its run shows in the session
    // view the shared launch checks, is a no-op. The launch runs the setup
    // conversation to its end, past the card action that started it, and
    // stops with the window.
    const setupLaunch = yield* FiberHandle.make<void, never>();
    return {
      runSetup: (launch) =>
        Effect.asVoid(
          FiberHandle.run(
            setupLaunch,
            withProcessServices(runtime, kickoffSetup(launch)),
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
