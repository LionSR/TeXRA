import { Data, Effect } from 'effect';
import { OnboardingFunnelRefresher } from '@controllers/onboarding/onboardingFunnel';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
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
 * way, through the host's asynchronous-error reporter, so they share one tag.
 */
class OnboardingDismissFailed extends Data.TaggedError(
  'OnboardingDismissFailed',
)<{
  readonly cause: unknown;
}> {}

/**
 * A capability behind a card action that still answers with a promise
 * rejected. `member` names which one; `cause` is the value the promise
 * rejected with, which the request's dialog classifies and presents as it
 * presented the bare rejection.
 */
export class OnboardingCallFailed extends Data.TaggedError(
  'OnboardingCallFailed',
)<{
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
   *  program is forked below, so its own failure is the host's to word. */
  kickoffSetup: () => Effect.Effect<void, Error>;
  /** Run ChatGPT sign-in flow from the welcome card. */
  signInWithChatGpt: () => Effect.Effect<void, Error, ProcessServices>;
  onAsyncError: (error: unknown) => void;
  /** The process runtime the composition root built; the funnel refresh runs
   *  on it rather than on a looked-up one. */
  runtime: ProcessRuntime;
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

  // Single guarded entry point for launching setup. The explicit "Run Setup"
  // card action routes through here so a setup run can't be started twice
  // concurrently — the host's `handleExecute`/`runAgent` has no in-flight
  // dedup of its own.
  function startSetupKickoff(): void {
    if (setupKickoffStarted) return;
    setupKickoffStarted = true;
    // Fire-and-forget: the host kickoff runs the setup conversation to
    // completion, which must NOT block the serialized funnel-refresh chain —
    // otherwise a later "skip setup" / sign-out / credential-removal refresh
    // would queue behind the entire setup run, leaving the card stuck on 'setup'.
    options.runtime.runFork(
      options.kickoffSetup().pipe(
        // Swallow — the kickoff handler already surfaced the error to the user.
        Effect.ignore,
        // Clear the guard once the run settles (success or failure), not only on
        // error: while it's in flight the guard blocks a concurrent second run,
        // but afterwards another manual "Run Setup" click must be able to launch
        // setup again (otherwise the guard would stay stuck for the window's
        // lifetime after the first kickoff).
        Effect.ensuring(
          Effect.sync(() => {
            setupKickoffStarted = false;
          }),
        ),
      ),
    );
  }

  const dismiss = Effect.gen(function* () {
    yield* state
      .update(DESKTOP_ONBOARDING_DISMISSED_STATE_KEY, true)
      .pipe(Effect.mapError((cause) => new OnboardingDismissFailed({ cause })));
    yield* Effect.try({
      try: () =>
        renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(false)),
      catch: (cause) => new OnboardingDismissFailed({ cause }),
    });
  });

  const skipMainOnboarding = (): OnboardingAction =>
    setOnboardingDeclined(state, true).pipe(Effect.flatMap(() => funnel.run()));

  const skipSetup = (): OnboardingAction =>
    setFirstRunDone(state, true).pipe(Effect.flatMap(() => funnel.run()));

  const runSetup = (): OnboardingAction =>
    Effect.suspend(() => {
      // Route through the shared guard so a double-click of "Run Setup" can't
      // launch a second concurrent run.
      startSetupKickoff();
      return funnel.run();
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
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE:
          options.runtime.runFork(
            postCurrentState.pipe(
              Effect.catch((failure) =>
                Effect.sync(() => options.onAsyncError(failure)),
              ),
            ),
          );
          return true;
        case DESKTOP_ONBOARDING_COMMANDS.DISMISS:
          options.runtime.runFork(
            dismiss.pipe(
              // The reporter receives the rejection itself, exactly as the
              // promise-side handler on this call used to hand it over. The
              // handler's parameter names the channel's whole error type, so a
              // second tag added to `dismiss` fails to compile here.
              Effect.catch((failure: OnboardingDismissFailed) =>
                Effect.sync(() => options.onAsyncError(failure.cause)),
              ),
            ),
          );
          return true;
        default:
          return false;
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
