/**
 * Host-neutral onboarding funnel.
 *
 * The funnel state is derived, never a mode the user (or code) sets:
 *
 *   0 — needs-credential  no usable credential, not previously declined
 *   1 — setup             credential present, first run not yet completed
 *   2 — done              a run has completed (or the user opted out)
 *
 * All inputs are user-scoped (global state / secrets), never
 * workspace-scoped: onboarding is a fact about the user, and a fresh
 * workspace must never demote a veteran back to State 0/1. Each host
 * (extension, CLI, desktop) computes `hasCredential` with its own credential
 * sources and reads and writes the flags below through its `AppState` store.
 *
 * The derivation is the planner below; the in-session loop around it — probe,
 * plan, publish, clear a stale skip, serialized against itself — is
 * `OnboardingFunnelRefresher`, which the webview hosts own one of each.
 */

import { Effect, Schema, type Scope, Semaphore, Stream } from 'effect';

import {
  AppState,
  Settings,
  StateReadFailed,
  withLogChannel,
} from '@texra-ai/harness/host';
import {
  agentName,
  isLiveRun,
  RUN_PHASE,
  type RunView,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { OnboardingFunnelState } from '@texra/shared/session/hostSnapshot';
import type { Session } from '@texra-ai/harness';
import type { StateStore, StateWriteFailed } from '@texra-ai/harness/host';

/** "Skip for now" on the State 0 picker. The key keeps the CLI's spelling,
 *  under which it was first stored. */
const DECLINED_KEY = 'texra.cli.onboardingDeclined';
/** A real run completed, or the user skipped setup. */
const FIRST_RUN_DONE_KEY = 'texra.onboarding.firstRunDone';

/** An onboarding flag: off until something sets it. */
const OnboardingFlagSchema = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(false)),
);

/** Record whether the user chose "Skip for now" on the State 0 picker. */
export function setOnboardingDeclined(
  state: StateStore,
  declined: boolean,
): Effect.Effect<void, StateWriteFailed> {
  return state.update(DECLINED_KEY, declined);
}

/** Whether a real run has completed (or the user skipped setup). */
export function getFirstRunDone(state: StateStore) {
  return Settings.state(state, FIRST_RUN_DONE_KEY, OnboardingFlagSchema);
}

/** Record that a real run completed or the user skipped setup. */
export function setFirstRunDone(
  state: StateStore,
): Effect.Effect<void, StateWriteFailed> {
  return state.update(FIRST_RUN_DONE_KEY, true);
}

/** The agent `run` runs, or undefined for a run that is not an agent's. */
function agentOf(run: RunView): string | undefined {
  return run.identity.kind === 'agent'
    ? agentName(run.identity.agent)
    : undefined;
}

/** Whether `view` holds a completed agent run other than the setup
 *  agent's own. Subagent runs count, so the demo the setup conversation
 *  delegates ends State 1. */
function hasCompletedRun(view: SessionView): boolean {
  for (const run of view.runs.values()) {
    const agent = agentOf(run);
    if (
      run.status === RUN_PHASE.COMPLETED &&
      agent !== undefined &&
      agent !== SETUP_AGENT_NAME
    )
      return true;
  }
  return false;
}

/** Whether `view` holds a setup conversation that has not ended, however
 *  it was started: a second one would race its installs and config
 *  writes. */
export function hasLiveSetupRun(view: SessionView): boolean {
  for (const run of view.runs.values()) {
    if (isLiveRun(run) && agentOf(run) === SETUP_AGENT_NAME) return true;
  }
  return false;
}

/**
 * Set the first-run flag once `session` holds a completed run
 * ({@link hasCompletedRun}), for the caller's scope. Each process that opens
 * a session calls this beside the open. Closing the scope checks the view one
 * last time, so a process that exits as its run ends (a headless
 * `texra run`) still records it. Best-effort: the flag feeds the funnel, so a
 * failed read or write is logged and never reaches the session.
 */
export const recordFirstCompletedRun = Effect.fn('recordFirstCompletedRun')(
  function* (session: Session): Effect.fn.Return<void, never, Scope.Scope> {
    const state = session.roots.globalState;
    const record = getFirstRunDone(state).pipe(
      Effect.flatMap((done) => (done ? Effect.void : setFirstRunDone(state))),
      Effect.catch((error) =>
        Effect.logWarning('Failed to record the first completed run').pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel('onboarding'),
        ),
      ),
    );
    yield* Effect.addFinalizer(() =>
      hasCompletedRun(session.view.current()) ? record : Effect.void,
    );
    yield* session.view.changes.pipe(
      Stream.filter(hasCompletedRun),
      Stream.take(1),
      Stream.runForEach(() => record),
      Effect.forkScoped,
    );
  },
);

/**
 * Run `refresh` as subscribed and whenever `firstRunDone` may have been
 * written, by this process or another sharing the store. The flag is written
 * by {@link recordFirstCompletedRun} in whichever process held the run, not
 * at a run's end, so a host follows the flag rather than its own launches; a
 * setup chat that waits after delegating has done its first run too.
 */
export const followFirstRunDone = (
  refresh: Effect.Effect<void>,
): Effect.Effect<void, never, AppState> =>
  Stream.unwrap(
    Effect.map(AppState, (state) => state.changes([FIRST_RUN_DONE_KEY])),
  ).pipe(Stream.runForEach(() => refresh));

interface OnboardingFunnelInputs {
  /** A usable credential exists (a subscription or any provider API key). */
  hasCredential: boolean;
  /** The user saw the State 0 picker and chose "Skip for now". */
  declined: boolean;
  /** A run has completed (or the setup agent handed off). */
  firstRunDone: boolean;
}

function deriveOnboardingFunnelState(
  inputs: OnboardingFunnelInputs,
): OnboardingFunnelState {
  if (inputs.firstRunDone) return 'done';
  if (inputs.hasCredential) return 'setup';
  // A deliberate skip suppresses State 0 on subsequent launches; the user
  // gets the normal product until a credential appears (which re-enters the
  // funnel at State 1 because configuring a credential clears the flag).
  return inputs.declined ? 'done' : 'needs-credential';
}

/** What a host should do after recomputing the funnel. */
interface OnboardingFunnelTransition {
  /** The newly derived funnel state (push to the webview). */
  state: OnboardingFunnelState;
  /** Select the setup agent in the launcher (entering State 1). */
  selectSetupAgent: boolean;
  /** Configuring a credential clears a previous skip. */
  clearDeclined: boolean;
}

/**
 * Pure transition planner for hosts that recompute the funnel in-session
 * (webview ready, credential-changed events, skip). `previous` is the state
 * from the host's last computation, or `undefined` on the first one.
 *
 * Entering State 1 only *selects* the setup agent and shows the setup card; it
 * never auto-starts the setup conversation. The setup agent runs an
 * environment probe that may install tools, so launching it is an explicit,
 * consented action — the user clicks "Run setup assistant" on the setup card
 * (or invokes the command) to start it. There is deliberately no auto-kickoff.
 */
function planOnboardingFunnelTransition(
  previous: OnboardingFunnelState | undefined,
  inputs: OnboardingFunnelInputs,
): OnboardingFunnelTransition {
  const state = deriveOnboardingFunnelState(inputs);
  return {
    state,
    // Entering State 1 (from ready, State 0, or a declined "done") selects
    // the setup agent; a refresh already in State 1 must not stomp a user
    // who deliberately switched agents mid-session.
    selectSetupAgent: state === 'setup' && previous !== 'setup',
    clearDeclined: inputs.declined && inputs.hasCredential,
  };
}

/** What one host contributes to a funnel refresh. */
interface OnboardingFunnelHost {
  /**
   * This host's usable-credential check (a subscription or any provider API
   * key), as a program the refresh yields. A check that cannot be answered
   * fails: it is not the fact "no credential", and reading it as one would
   * blank a user who has keys back down to the first-run welcome card.
   */
  readonly hasCredential: () => Effect.Effect<boolean, Error>;
  /** The user-scoped flag store; onboarding is a fact about the user. */
  readonly flags: StateStore;
  /**
   * Paint the derived state and take the arms this host answers. The
   * extension selects the setup agent on its launcher; the desktop discards
   * that arm. The refresh waits for the host publication before another
   * refresh can observe the transition.
   */
  readonly apply: (
    transition: OnboardingFunnelTransition & {
      /** This refresh moved the funnel state; the first one always does. */
      readonly changed: boolean;
    },
  ) => Effect.Effect<void>;
}

/**
 * The in-session funnel loop, owned once beside its planner: probe the host's
 * credentials, plan the transition against the state this refresher last
 * derived, hand it to the host, and clear a stale skip.
 *
 * Refreshes are serialized because the probe awaits and the previous state is
 * shared: without a lane the last caller to finish could publish a state
 * planned from a stale previous one. One permit — a refresh holds it while it
 * runs, callers that arrive meanwhile wait in order and are collapsed into the
 * single rerun they asked for, and each returns once that rerun has landed.
 * The latch and the program it reruns are one pair, so a caller's `run` can
 * only ever be answered by this refresh; the request is latched when the
 * program starts, not when it is built, so an unrun `run` leaves no rerun owed
 * to nobody.
 */
export class OnboardingFunnelRefresher {
  private readonly lane = Semaphore.makeUnsafe(1);
  private rerunRequested = false;
  private current: OnboardingFunnelState | undefined;

  private readonly host: OnboardingFunnelHost;
  constructor(host: OnboardingFunnelHost) {
    this.host = host;
  }

  /** The state this refresher last derived, `undefined` before the first
   *  refresh. Session-scoped by design. */
  get state(): OnboardingFunnelState | undefined {
    return this.current;
  }

  private readonly refresh = Effect.fn('OnboardingFunnelRefresher.refresh')(
    function* (this: OnboardingFunnelRefresher) {
      // An unanswered check fails the refresh before anything is applied:
      // the funnel keeps the state it last derived, the caller's boundary
      // reports why (on the first refresh there is no state to keep), and
      // the next refresh asks again.
      const hasCredential = yield* this.host.hasCredential().pipe(
        Effect.mapError(
          (failure) =>
            new StateReadFailed({
              key: 'onboarding.credential',
              message: `The onboarding credential check failed: ${failure.message}`,
              cause: failure,
            }),
        ),
      );
      const transition = planOnboardingFunnelTransition(this.current, {
        hasCredential,
        declined: yield* Settings.state(
          this.host.flags,
          DECLINED_KEY,
          OnboardingFlagSchema,
        ),
        firstRunDone: yield* getFirstRunDone(this.host.flags),
      });
      const changed = this.current !== transition.state;
      yield* this.host.apply({ ...transition, changed });
      this.current = transition.state;
      if (transition.clearDeclined) {
        yield* setOnboardingDeclined(this.host.flags, false);
      }
    },
  );

  private readonly drain = Effect.fn('OnboardingFunnelRefresher.run')(
    function* (this: OnboardingFunnelRefresher) {
      while (this.rerunRequested) {
        this.rerunRequested = false;
        yield* this.refresh();
      }
    },
  );

  /** Ask for a refresh. It fails when the credential probe or a flag read
   *  cannot be answered, or the write that clears a stale skip fails; the
   *  host publication cannot fail. */
  run(): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
    return Effect.suspend(() => {
      this.rerunRequested = true;
      return this.lane.withPermit(this.drain());
    });
  }
}
