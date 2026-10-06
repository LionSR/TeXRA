import { computed, signal } from '@lit-labs/signals';

import { CliExitCode } from '@cli/runtime/exitCodes';
import { RUN_PHASE, type RunPhase, type RunId } from '@shared/schemas';
import { isActivePhase } from '@shared/runs/runStatus';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';

import { registerCliStateResetHook } from './cliState';
import { runPhaseOf, runViewOf, sessionView } from './sessionView';
import type { Effect } from 'effect';

type RunControlsOf = SessionBackend['controls'];

/**
 * The claimed root run's settlement, as the slot holds it: the program that
 * completes when that run finishes, fails or is interrupted. It is the
 * `Deferred.await` of the deferred the claiming path settles, so the slot
 * stores a value every reader runs on its own fiber instead of a promise the
 * claim had to run a fiber to produce.
 */
export type RootRunSettled = Effect.Effect<void, Error>;

/**
 * The root session's run claim: the run it claimed (cleared while a new run
 * is pending, unlike `rootRunId`, which stays put as the transcript anchor
 * across pending windows), that run's settlement, and whether it finished.
 * Held in a signal, not in `TuiSession` fields, so renders read the claim
 * reactively instead of calling impure session closures that memoized
 * renders would cache stale (#8273). Written only through `TuiSession`.
 */
interface RootRunClaim {
  readonly runId: RunId | undefined;
  readonly runSettled: RootRunSettled | undefined;
  readonly runCompleted: boolean;
}

const NO_CLAIM: RootRunClaim = {
  runId: undefined,
  runSettled: undefined,
  runCompleted: false,
};

const rootRunClaim = signal<RootRunClaim>(NO_CLAIM);
registerCliStateResetHook(() => rootRunClaim.set(NO_CLAIM));

/** The run facts the stop predicates consume, read by the session, the
 *  status bar's Ctrl-C hint and the terminal title. */
export const runStopFacts = computed((): ChatTuiRunStopFacts => {
  const claim = rootRunClaim.get();
  return {
    runPending: chatTuiRunPending(claim),
    runId: claim.runId,
    status: runPhaseOf(runViewOf(sessionView().get(), claim.runId)),
  };
});

/**
 * Root-run state of one chat TUI session. The run claim lives in
 * {@link rootRunClaim}; its multi-field transitions are methods so each is
 * one write rather than a half-applied intermediate state. The run-control
 * questions the exit paths and slash commands ask are methods too, read live
 * from the session view and the session's tool-use flows.
 */
export class TuiSession {
  /** A new session starts with no claim. `runsElsewhere`: its runs run in
   *  the background service, so leaving the chat never ends one. */
  constructor(
    private readonly runControlsOf: RunControlsOf,
    private readonly runsElsewhere = false,
  ) {
    rootRunClaim.set(NO_CLAIM);
  }

  /** Root conversation that remains recoverable after an interrupted turn. */
  interruptedRunId: RunId | undefined;
  runExitCode: CliExitCode = CliExitCode.Success;
  stopRequested = false;

  get runId(): RunId | undefined {
    return rootRunClaim.get().runId;
  }

  set runId(runId: RunId | undefined) {
    rootRunClaim.set({ ...rootRunClaim.get(), runId });
  }

  get runSettled(): RootRunSettled | undefined {
    return rootRunClaim.get().runSettled;
  }

  get runCompleted(): boolean {
    return rootRunClaim.get().runCompleted;
  }

  clearRunState(): void {
    rootRunClaim.set(NO_CLAIM);
    this.interruptedRunId = undefined;
    this.runExitCode = CliExitCode.Success;
    this.stopRequested = false;
  }

  markRunPending(runSettled: RootRunSettled): void {
    rootRunClaim.set({ runId: undefined, runSettled, runCompleted: false });
    this.runExitCode = CliExitCode.Success;
    this.stopRequested = false;
  }

  /** The exit code a claim's run ends with, while the slot still holds that
   *  claim: a run it replaced does not set the chat's exit. */
  settleExitCode(runSettled: RootRunSettled, code: CliExitCode): void {
    if (this.holdsClaim(runSettled)) this.runExitCode = code;
  }

  /** Whether the slot still holds the claim `runSettled` belongs to. */
  holdsClaim(runSettled: RootRunSettled): boolean {
    return rootRunClaim.get().runSettled === runSettled;
  }

  /** The claim `runSettled` belongs to is over. A claim the slot no longer
   *  holds is left alone: a chain that settles after the slot moved on (a
   *  resume taken up before the run it replaced finished settling) must not
   *  free the claim that replaced it. */
  markRunCompleted(runSettled: RootRunSettled): void {
    if (!this.holdsClaim(runSettled)) return;
    rootRunClaim.set({ ...rootRunClaim.get(), runCompleted: true });
  }

  /**
   * Atomically check-and-claim the root-run slot: fuses
   * {@link chatTuiCanStartRootRun} and {@link markRunPending} into one
   * synchronous call so no caller can observe — or race on — a window between
   * the check and the claim. Every root-run entry point that awaits *before*
   * it would otherwise claim (resume, follow-up-wake resume) MUST call this as
   * its first statement, before any `await`, so the claim happens before the
   * caller can be suspended and a concurrent entry point can slip in and claim
   * the same slot. `startRootRun` claims via `markRunPending` directly
   * instead — it never suspends before claiming, so it has no check-then-await
   * window for this primitive to close.
   */
  tryClaimRootRunSlot(runSettled: RootRunSettled): boolean {
    if (!chatTuiCanStartRootRun(this)) return false;
    this.markRunPending(runSettled);
    return true;
  }

  /** The claimed run's phase, as the session view folds it. */
  status(): RunPhase | undefined {
    return runStopFacts.get().status;
  }

  /** The claimed run's live controls, while its loop runs. */
  activeRunControls(): ReturnType<RunControlsOf> {
    const { runId } = this;
    return runId ? this.runControlsOf(runId) : undefined;
  }

  /** Model selection is open with no pending run, or at a tool-use wait. */
  canSelectModel(): boolean {
    return (
      chatTuiCanStartRootRun(this) ||
      (this.status() === RUN_PHASE.WAITING &&
        this.activeRunControls() !== undefined)
    );
  }

  /** Whether an actively-running turn can be stopped (vs idle/WAITING). */
  canStopVisibleRun(): boolean {
    return chatTuiCanStopVisibleRun(runStopFacts.get());
  }

  /**
   * On exit, a tool-use session suspended at a wait (idle/WAITING) with an
   * active tool-use run is not stopped the way a Ctrl-C stops a turn: the
   * user's stop policy (`detachSubagentsOnStop`) does not apply, and the exit
   * needs no second Ctrl-C. The session's close still ends the generation,
   * which records its terminal `run.end` as cancelled ("Stopped"): every
   * activation ends with one, and a run left without it would read as
   * interrupted by a crash. Resumability survives either way: a run's rows
   * stay until the run is explicitly deleted.
   */
  isResumableIdle(): boolean {
    // The service holds the task: the chat leaves it as it is, any time.
    if (this.runsElsewhere) return true;
    return (
      this.runId !== undefined &&
      chatTuiRunPending(this) &&
      !this.canStopVisibleRun() &&
      this.activeRunControls() !== undefined
    );
  }
}

type PendingTuiRunSessionState = Pick<
  RootRunClaim,
  'runSettled' | 'runCompleted'
>;

/** Run facts the stop predicates consume: {@link runStopFacts}. */
interface ChatTuiRunStopFacts {
  readonly runPending: boolean;
  readonly runId: RunId | undefined;
  readonly status: RunPhase | undefined;
}

export function chatTuiCanStopActiveRun(facts: ChatTuiRunStopFacts): boolean {
  if (!facts.runPending) return false;
  if (!facts.runId) return true;
  return facts.status === undefined || isActivePhase(facts.status);
}

export function chatTuiCanStopVisibleRun(facts: ChatTuiRunStopFacts): boolean {
  return (
    chatTuiCanStopActiveRun(facts) ||
    Boolean(facts.runId && isActivePhase(facts.status))
  );
}

/** Whether the session still holds an unfinished root-run claim. Sole
 *  derivation of that fact: the availability predicate, {@link runStopFacts},
 *  and every caller-side "a run is in flight" check read it here instead of
 *  re-deriving `runSettled && !runCompleted`. */
export function chatTuiRunPending(session: PendingTuiRunSessionState): boolean {
  return Boolean(session.runSettled) && !session.runCompleted;
}

export function chatTuiCanStartRootRun(
  session: PendingTuiRunSessionState,
): boolean {
  return !chatTuiRunPending(session);
}
