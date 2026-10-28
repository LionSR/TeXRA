import { Effect } from 'effect';
import { type RequestRefusal } from '@texra-ai/harness';
import {
  StateStore,
  StateWriteFailed,
  StateReadFailed,
} from '@texra-ai/harness/host';
import {
  OnboardingFunnelRefresher,
  setFirstRunDone,
  setOnboardingDeclined,
} from '@texra/controllers/onboarding/onboardingFunnel';
import {
  hostFailure,
  type HostCallFailed,
} from '@texra/controllers/session/hostCallFailure';
import type { OnboardingFunnelState } from '@texra/shared/session/hostSnapshot';
import type { ProcessServices } from '@texra-ai/harness/host';

/** How a card action fails: the funnel's flag write, plus whatever the
 *  sign-in program failed with. */
type OnboardingAction<E = never, R = never> = Effect.Effect<
  void,
  StateWriteFailed | StateReadFailed | E,
  R
>;

interface DesktopOnboardingIpcOptions {
  /** The process global store, handed down by the composition root. */
  state: StateStore;
  /**
   * Host-provided check for a usable credential (a subscription or any
   * provider API key), as a program: the secrets read behind it is one, and
   * the funnel refresh below yields it on the runtime it already holds. A
   * check that cannot be answered fails, and the funnel keeps its state.
   */
  hasCredential: () => Effect.Effect<boolean, Error>;
  /** Launch the setup conversation when the user clicks "Run Setup". The
   *  host reports its own failure, so the program never fails. */
  kickoffSetup: () => Effect.Effect<void>;
  /** Run ChatGPT sign-in flow from the welcome card. */
  signInWithChatGpt: () => Effect.Effect<void, Error, ProcessServices>;
}

/**
 * The onboarding funnel of one window: the funnel state the `host` snapshot
 * carries and the card actions the host request handlers call.
 */
export interface DesktopOnboardingIpc {
  /** Recompute the funnel from credentials + flags and publish it. */
  refreshOnboardingFunnel(): OnboardingAction;
  /** The funnel as last derived; null before the first refresh. */
  funnelState(): OnboardingFunnelState | null;
  /** Fires after every refresh that changed the funnel. */
  onFunnelChange(
    listener: (state: OnboardingFunnelState) => Effect.Effect<void>,
  ): () => void;
  /** The welcome card's skip: persists the declined flag and refreshes. */
  skipOnboarding(): OnboardingAction;
  /** The setup card's skip: marks the first run done and refreshes. */
  skipSetup(): OnboardingAction;
  /** The setup card's Run Setup: launches the setup conversation. */
  runSetup(): OnboardingAction;
  signInWithChatGpt(): OnboardingAction<
    HostCallFailed | RequestRefusal,
    ProcessServices
  >;
}

export function createDesktopOnboardingIpc(
  options: DesktopOnboardingIpcOptions,
): DesktopOnboardingIpc {
  const state = options.state;
  let setupKickoffStarted = false;
  const funnelListeners = new Set<
    (state: OnboardingFunnelState) => Effect.Effect<void>
  >();
  // This host's half of the shared funnel loop. Entering State 1 only paints
  // the setup card (the launcher's agent selection is the surface's), so the
  // `selectSetupAgent` arm is deliberately discarded here as it is in the CLI;
  // the user launches setup explicitly via the card's "Run Setup" button.
  const funnel = new OnboardingFunnelRefresher({
    hasCredential: () => options.hasCredential(),
    flags: state,
    apply: ({ state: funnelState, changed }) =>
      changed
        ? Effect.forEach(
            [...funnelListeners],
            (listener) => listener(funnelState),
            { discard: true },
          )
        : Effect.void,
  });

  const skipMainOnboarding = (): OnboardingAction =>
    setOnboardingDeclined(state, true).pipe(Effect.flatMap(() => funnel.run()));

  const skipSetup = (): OnboardingAction =>
    setFirstRunDone(state).pipe(Effect.flatMap(() => funnel.run()));

  // The guard keeps a double-click of "Run Setup" from launching a second
  // concurrent run — the host's root launch has no in-flight dedup of its
  // own.
  const runSetup = (): OnboardingAction =>
    Effect.gen(function* () {
      if (!setupKickoffStarted) {
        setupKickoffStarted = true;
        // Fire-and-forget: the host kickoff runs the setup conversation to
        // completion, which must NOT block the serialized funnel-refresh
        // chain — otherwise a later "skip setup" / sign-out /
        // credential-removal refresh would queue behind the entire setup run,
        // leaving the card stuck on 'setup'. Detached, so the run outlives
        // the card action that started it.
        yield* options.kickoffSetup().pipe(
          // Clear the guard once the run finishes (success or failure): while
          // it's in flight the guard blocks a concurrent second run, but
          // afterwards another manual "Run Setup" click must launch again.
          Effect.ensuring(
            Effect.sync(() => {
              setupKickoffStarted = false;
            }),
          ),
          Effect.forkDetach,
        );
      }
      return yield* funnel.run();
    });

  const signInWithChatGpt = (): OnboardingAction<
    HostCallFailed | RequestRefusal,
    ProcessServices
  > =>
    options.signInWithChatGpt().pipe(
      Effect.mapError((cause) =>
        hostFailure('onboarding.signInWithChatGpt', cause),
      ),
      Effect.flatMap(() => funnel.run()),
    );

  return {
    refreshOnboardingFunnel: () => funnel.run(),
    funnelState: () => funnel.state ?? null,
    onFunnelChange(listener) {
      funnelListeners.add(listener);
      return () => {
        funnelListeners.delete(listener);
      };
    },
    skipOnboarding: skipMainOnboarding,
    skipSetup,
    runSetup,
    signInWithChatGpt,
  };
}
