import { computed, signal } from '@lit-labs/signals';

import type { SessionHandle } from '@agent/runtime';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { RUN_PHASE, type RunPhase, type RunId } from '@shared/schemas';
import { isActivePhase } from '@shared/runs/runStatus';

import { registerCliStateResetHook } from './cliState';
import { runPhaseOf, runViewOf, sessionView } from './sessionView';
import type { Effect } from 'effect';

type ToolUseFlowOf = SessionHandle['runs']['getToolUseFlowContext'];

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
  /** A new session starts with no claim. */
  constructor(private readonly toolUseFlowOf: ToolUseFlowOf) {
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

  markRunCompleted(): void {
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

  /** The claimed run's live tool-use flow, if it has one. */
  activeToolUseFlow(): ReturnType<ToolUseFlowOf> {
    const { runId } = this;
    return runId ? this.toolUseFlowOf(runId) : undefined;
  }

  /** Model selection is open with no pending run, or at a tool-use wait. */
  canSelectModel(): boolean {
    return (
      chatTuiCanStartRootRun(this) ||
      (this.status() === RUN_PHASE.WAITING &&
        this.activeToolUseFlow() !== undefined)
    );
  }

  /** Whether an actively-running turn can be stopped (vs idle/WAITING). */
  canStopVisibleRun(): boolean {
    return chatTuiCanStopVisibleRun(runStopFacts.get());
  }

  /**
   * On exit, a tool-use session suspended at a wait (idle/WAITING) with an
   * active tool-use run is left uninterrupted. Resumability survives either
   * way: a run's rows and its latest `flow.snapshot` stay until the run is
   * explicitly deleted, so even a CANCELLED run remains resumable. What this
   * preserves is the run's persisted status and its side effects: an idle exit
   * leaves the run WAITING instead of recording a CANCELLED the user never
   * asked for, and does not clear approvals or sweep active children through
   * `detachSubagentsOnStop`.
   */
  isResumableIdle(): boolean {
    return (
      this.runId !== undefined &&
      chatTuiRunPending(this) &&
      !this.canStopVisibleRun() &&
      this.activeToolUseFlow() !== undefined
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
