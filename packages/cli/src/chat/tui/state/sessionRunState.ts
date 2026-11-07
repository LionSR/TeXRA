import { computed, signal } from '@lit-labs/signals';
import { Effect } from 'effect';

import { isWorking, type RunId } from '@texra-ai/harness/schemas';
import { CliExitCode } from '@cli/runtime/exitCodes';

import { registerCliStateResetHook, sessionViewFailure } from './cliState';
import {
  runPhaseOf,
  runViewOf,
  sessionView,
  type RunPhase,
} from './sessionView';

/**
 * The claimed root run's end, as the slot holds it: the program that
 * completes when that run finishes, fails or is interrupted. It is the
 * `Deferred.await` of the deferred the claiming path finishes, so the slot
 * stores a value every reader runs on its own fiber instead of a promise the
 * claim had to run a fiber to produce.
 */
export type RootRunSettled = Effect.Effect<void, Error>;

/**
 * The root session's run claim: the run it claimed (cleared while a new run
 * is pending, unlike `rootRunId`, which stays put as the transcript anchor
 * across pending windows), that run's end, and whether it finished.
 * Held in a signal, not in `TuiSession` fields, so renders read the claim
 * reactively instead of calling impure session closures that memoized
 * renders would cache stale (#8273). Written only through `TuiSession`.
 */
interface RootRunClaim {
  readonly runId: RunId | undefined;
  readonly runSettled: RootRunSettled | undefined;
  readonly runCompleted: boolean;
  /** Done once the session holds the claim's run, or its launch failed: a
   *  stop asked meanwhile waits for it and lands on the run it bore. */
  readonly launched: Effect.Effect<void>;
  /** The exit code the claim's run ends with, written only through
   *  `settleExitCode`. */
  readonly exitCode: CliExitCode;
}

const NO_CLAIM: RootRunClaim = {
  runId: undefined,
  runSettled: undefined,
  runCompleted: false,
  launched: Effect.void,
  exitCode: CliExitCode.Success,
};

/** How the chat leaves, once decided: on its own (`/exit`, a Ctrl-C with
 *  nothing to stop), or on a signal with that signal's exit code. */
export type ChatExit =
  | { readonly kind: 'graceful' }
  | { readonly kind: 'signal'; readonly exitCode: number };

const rootRunClaim = signal<RootRunClaim>(NO_CLAIM);
registerCliStateResetHook(() => rootRunClaim.set(NO_CLAIM));

/** The run facts the stop predicates consume, read by the session, the
 *  status bar's Ctrl-C hint and the terminal title. */
export const runStopFacts = computed((): ChatTuiRunStopFacts => {
  const claim = rootRunClaim.get();
  const run = runViewOf(sessionView().get(), claim.runId);
  return {
    runPending: chatTuiRunPending(claim),
    runId: claim.runId,
    status: runPhaseOf(run),
    working: run != null && isWorking(run),
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
  private readonly runsElsewhere: boolean;

  /** A new session starts with no claim. `runsElsewhere`: its runs run in
   *  the background service, so leaving the chat never ends one. */
  constructor(runsElsewhere = false) {
    this.runsElsewhere = runsElsewhere;
    rootRunClaim.set(NO_CLAIM);
  }

  /** The chat's one exit, once an exit path decided it: its result is the
   *  code the chat ends with. While it is set the chat is leaving: a message
   *  typed now goes back to the input, and a run that fails now says
   *  nothing. */
  exited: Promise<CliExitCode> | undefined;

  /** The chat's exit code: a dead session view is a failure on every exit
   *  path; otherwise the claimed run's, as `settleExitCode` wrote it. */
  get exitCode(): CliExitCode {
    return sessionViewFailure.get() !== undefined
      ? CliExitCode.AgentError
      : rootRunClaim.get().exitCode;
  }

  /** The slot's claim, as a stop reads it: the run it names, its end and
   *  its launch. */
  get claim(): RootRunClaim {
    return rootRunClaim.get();
  }

  get runId(): RunId | undefined {
    return rootRunClaim.get().runId;
  }

  /** The held claim's run moves to the one a resume adopted (its parent). */
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
  }

  /** Claim the slot for `runSettled`'s run, `runId`, in one write, so a
   *  message typed while the claimant is still choosing its model already
   *  names the run it will go to. */
  markRunPending(
    runSettled: RootRunSettled,
    launched: Effect.Effect<void>,
    runId?: RunId,
  ): void {
    rootRunClaim.set({
      runId,
      runSettled,
      runCompleted: false,
      launched,
      exitCode: CliExitCode.Success,
    });
  }

  /** The exit code a claim's run ends with, while the slot still holds that
   *  claim: a run it replaced does not set the chat's exit. */
  settleExitCode(runSettled: RootRunSettled, code: CliExitCode): void {
    if (this.holdsClaim(runSettled))
      rootRunClaim.set({ ...rootRunClaim.get(), exitCode: code });
  }

  /** Whether the slot still holds the claim `runSettled` belongs to. */
  holdsClaim(runSettled: RootRunSettled): boolean {
    return rootRunClaim.get().runSettled === runSettled;
  }

  /** The claim `runSettled` belongs to is over. A claim the slot no longer
   *  holds is left alone: a chain that finishes after the slot moved on (a
   *  resume taken up before the run it replaced had ended) must not
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
   * the same slot. `launchRootRun` claims via `markRunPending` directly
   * instead — it never suspends before claiming, so it has no check-then-await
   * window for this primitive to close.
   */
  tryClaimRootRunSlot(
    runSettled: RootRunSettled,
    launched: Effect.Effect<void>,
    runId?: RunId,
  ): boolean {
    if (!chatTuiCanStartRootRun(this)) return false;
    this.markRunPending(runSettled, launched, runId);
    return true;
  }

  /** The claimed run's phase, as the session view derives it. */
  status(): RunPhase | undefined {
    return runStopFacts.get().status;
  }

  /** Whether the claimed run is live, as the session view derives it: what
   *  a model switch reaches. */
  runLive(): boolean {
    const run = runViewOf(sessionView().get(), this.runId);
    return run !== undefined && run.holder === 'here';
  }

  /** Model selection is open with no pending run, or at a tool-use wait. */
  canSelectModel(): boolean {
    return (
      chatTuiCanStartRootRun(this) ||
      (this.status() === 'waiting' && this.runLive())
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
      this.runLive()
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
  readonly working: boolean;
}

export function chatTuiCanStopActiveRun(facts: ChatTuiRunStopFacts): boolean {
  if (!facts.runPending) return false;
  if (!facts.runId) return true;
  return facts.status === undefined || facts.working;
}

export function chatTuiCanStopVisibleRun(facts: ChatTuiRunStopFacts): boolean {
  return (
    chatTuiCanStopActiveRun(facts) || Boolean(facts.runId && facts.working)
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
