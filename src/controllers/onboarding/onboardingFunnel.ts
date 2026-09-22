/**
 * Host-neutral onboarding funnel (PRD: agent-native onboarding).
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
 * sources and reads the flags from `@shared/state/onboardingState` using its
 * `platform().globalState`.
 *
 * The derivation is the planner below; the in-session loop around it — probe,
 * plan, publish, clear a stale skip, serialized against itself — is
 * `OnboardingFunnelRefresher`, which the webview hosts own one of each.
 */

import { Effect, Semaphore } from 'effect';

import type {
  StateStore,
  StateReadFailed,
  StateWriteFailed,
} from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { OnboardingFunnelState } from '@shared/schemas';
import {
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';

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
  /** Configuring a credential clears a previous skip (PRD edge case). */
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
export function planOnboardingFunnelTransition(
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
   * key), as a program the refresh yields. It cannot fail: every host binds
   * `hasUsableSetupCredential`, which already warns about each probe it could
   * not answer and reads it as "no credential of that kind" — the funnel must
   * still paint, but never silently, since that answer blanks a user who has
   * keys back down to the first-run welcome card.
   */
  readonly hasCredential: () => Effect.Effect<boolean, never, LanguageModel>;
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

  constructor(private readonly host: OnboardingFunnelHost) {}

  /** The state this refresher last derived, `undefined` before the first
   *  refresh. Session-scoped by design. */
  get state(): OnboardingFunnelState | undefined {
    return this.current;
  }

  private readonly refresh = Effect.fn('OnboardingFunnelRefresher.refresh')(
    function* (this: OnboardingFunnelRefresher) {
      const hasCredential = yield* this.host.hasCredential();
      const transition = planOnboardingFunnelTransition(this.current, {
        hasCredential,
        ...(yield* readOnboardingFlags(this.host.flags)),
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

  /** Ask for a refresh. The only failure is the flag write that clears a
   *  stale skip; the credential probe and host publication cannot fail. */
  run(): Effect.Effect<
    void,
    StateReadFailed | StateWriteFailed,
    LanguageModel
  > {
    return Effect.suspend(() => {
      this.rerunRequested = true;
      return this.lane.withPermit(this.drain());
    });
  }
}
