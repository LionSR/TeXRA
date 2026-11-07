/**
 * Host-neutral onboarding funnel.
 *
 * The funnel state is derived, never a mode the user (or code) sets:
 *
 *   0 — needs-credential  no usable credential, not previously declined
 *   1 — setup             credential present, first run not yet completed
 *   2 — done              a run has completed (or the user opted out)
 *
 * The flags are user-scoped (global state), so a fresh workspace never
 * demotes a veteran back to State 0/1: `firstRunDone` wins. The credential
 * is the shown project's: each host (extension, CLI, desktop) computes
 * `hasCredential` under that project's `.env` over the process environment,
 * the key a run of that project would use, and reads and writes the flags
 * below through its `AppState` store.
 *
 * The derivation is {@link deriveOnboardingFunnelState}; each window's host
 * snapshot (`hostSnapshotSource.ts`) holds its inputs and follows them.
 */

import { Effect, Schema, type Scope, Stream } from 'effect';

import { Settings, withLogChannel } from '@texra-ai/harness/host';
import {
  agentName,
  RUN_PHASE,
  type SessionView,
} from '@texra-ai/harness/schemas';
import { SETUP_AGENT_NAME } from '@texra/shared/constants/agents';
import type { OnboardingFunnelState } from '@texra/shared/session/hostSnapshot';
import type { Session } from '@texra-ai/harness';
import type { StateStore, StateWriteFailed } from '@texra-ai/harness/host';

/** "Skip for now" on the State 0 picker. The key keeps the CLI's spelling,
 *  under which it was first stored. */
const DECLINED_KEY = 'cli.onboardingDeclined';
/** A real run completed, or the user skipped setup. */
const FIRST_RUN_DONE_KEY = 'onboarding.firstRunDone';

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

/** Whether `view` holds a completed agent run other than the setup
 *  agent's own. Subagent runs count, so the demo the setup conversation
 *  delegates ends State 1. */
function hasCompletedRun(view: SessionView): boolean {
  for (const run of view.runs.values()) {
    if (
      run.status === RUN_PHASE.COMPLETED &&
      run.identity.kind === 'agent' &&
      agentName(run.identity.agent) !== SETUP_AGENT_NAME
    )
      return true;
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

/** The flags {@link readOnboardingFlags} reads, for a follower of their
 *  changes (`AppStateStore.changes`): another process may write them. */
export const ONBOARDING_FLAG_KEYS: readonly string[] = Object.freeze([
  DECLINED_KEY,
  FIRST_RUN_DONE_KEY,
]);

/** The user's two onboarding flags. */
export const readOnboardingFlags = (state: StateStore) =>
  Effect.all({
    declined: Settings.state(state, DECLINED_KEY, OnboardingFlagSchema),
    firstRunDone: getFirstRunDone(state),
  });

interface OnboardingFunnelInputs {
  /** A usable credential exists (a subscription or any provider API key). */
  hasCredential: boolean;
  /** The user saw the State 0 picker and chose "Skip for now". */
  declined: boolean;
  /** A run has completed (or the setup agent handed off). */
  firstRunDone: boolean;
}

/**
 * The funnel state from its three inputs. Entering State 1 shows the setup
 * card; it never starts the setup conversation, whose environment probe may
 * install tools, so the user starts it from the card.
 */
export function deriveOnboardingFunnelState(
  inputs: OnboardingFunnelInputs,
): OnboardingFunnelState {
  if (inputs.firstRunDone) return 'done';
  if (inputs.hasCredential) return 'setup';
  // A deliberate skip suppresses State 0 on subsequent launches; the user
  // gets the normal product until a credential appears (which re-enters the
  // funnel at State 1 because configuring a credential clears the flag).
  return inputs.declined ? 'done' : 'needs-credential';
}
