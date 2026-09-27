import { Data, Effect } from 'effect';
import { OnboardingFunnelRefresher } from '@controllers/onboarding/onboardingFunnel';
import type { ProcessServices } from '@platform/processRuntime';
import type {
  StateStore,
  StateWriteFailed,
  StateReadFailed,
} from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { OnboardingFunnelState } from '@shared/schemas';
import {
  isRequestRefusal,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import {
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  buildDesktopOnboardingSetStateMessage,
  DESKTOP_ONBOARDING_COMMANDS,
  DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
} from '../shared/desktopOnboardingMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';

/**
 * The welcome card's dismissal did not land: either the flag write rejected or
 * the renderer refused the follow-up state message. Both are reported the same
 * way, through the window's router, so they share one tag; `message` is the
 * cause's own text, which the report shows.
 */
class OnboardingDismissFailed extends Data.TaggedError(
  'OnboardingDismissFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const dismissFailed = (cause: unknown) =>
  new OnboardingDismissFailed({ message: toErrorMessage(cause), cause });

/**
 * A capability behind a card action that still answers with a promise
 * rejected. `member` names which one; `cause` is the value the promise
 * rejected with, which the request's dialog classifies and presents as it
 * presented the bare rejection.
 */
class OnboardingCallFailed extends Data.TaggedError('OnboardingCallFailed')<{
  readonly member: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** How a card action fails: the funnel's flag write, plus whatever the
 *  sign-in program failed with. */
type OnboardingAction<E = never, R = LanguageModel> = Effect.Effect<
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
   * the funnel refresh below yields it on the runtime it already holds.
   */
  hasCredential: () => Effect.Effect<boolean, never, LanguageModel>;
  /** Launch the setup conversation when the user clicks "Run Setup". The
   *  host presents its own failure, so the program settles. */
  kickoffSetup: () => Effect.Effect<void>;
  /** Run ChatGPT sign-in flow from the welcome card. */
  signInWithChatGpt: () => Effect.Effect<void, Error, ProcessServices>;
}

/**
 * The onboarding funnel of one window: the startup team chooser's own two
 * messages, the funnel state the `host` snapshot carries (PRD 8.1), and the
 * card actions the host request arms call.
 */
export interface DesktopOnboardingIpc extends DesktopMessageHandler {
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
    OnboardingCallFailed | RequestRefusal,
    ProcessServices
  >;
}

export function createDesktopOnboardingIpc(
  renderer: DesktopRenderer,
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
  // the user launches setup explicitly via the card's "Run Setup" button
  // (ONBOARDING_RUN_SETUP).
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

  const postCurrentState = Effect.gen(function* () {
    const dismissed = yield* state.get<boolean>(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      false,
    );
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(!dismissed));
  });

  const dismiss = Effect.gen(function* () {
    yield* state
      .update(DESKTOP_ONBOARDING_DISMISSED_STATE_KEY, true)
      .pipe(Effect.mapError(dismissFailed));
    yield* Effect.try({
      try: () =>
        renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(false)),
      catch: dismissFailed,
    });
  });

  const skipMainOnboarding = (): OnboardingAction =>
    setOnboardingDeclined(state, true).pipe(Effect.flatMap(() => funnel.run()));

  const skipSetup = (): OnboardingAction =>
    setFirstRunDone(state, true).pipe(Effect.flatMap(() => funnel.run()));

  // The guard keeps a double-click of "Run Setup" from launching a second
  // concurrent run — the host's `handleExecute`/`runAgent` has no in-flight
  // dedup of its own.
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
          // Clear the guard once the run settles (success or failure): while
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
    OnboardingCallFailed | RequestRefusal,
    ProcessServices
  > =>
    options.signInWithChatGpt().pipe(
      Effect.mapError((cause) =>
        isRequestRefusal(cause)
          ? cause
          : new OnboardingCallFailed({
              member: 'onboarding.signInWithChatGpt',
              message: toErrorMessage(cause),
              cause,
            }),
      ),
      Effect.flatMap(() => funnel.run()),
    );

  return {
    handleMessage(message: DesktopCommandMessage) {
      switch (message.command) {
        case DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE:
          return postCurrentState;
        case DESKTOP_ONBOARDING_COMMANDS.DISMISS:
          return dismiss;
        default:
          return undefined;
      }
    },
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
