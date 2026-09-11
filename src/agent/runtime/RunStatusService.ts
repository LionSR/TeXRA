import type { StatusEvent } from '@agent/trace';
import {
  RUN_PHASE,
  type RunPhase,
  type RunSubstate,
  type RunId,
} from '@shared/schemas';
import {
  canTransitionRunPhase,
  isActivePhase,
  isInFlightPhase,
  isTerminalOutcomePhase,
  RUN_TRANSITION_CAUSE,
  type RunTransitionCause,
} from '@shared/runs/runStatus';

interface RunStatusEmitOptions {
  substate?: RunSubstate;
}

type WaitingTransitionCause = Extract<RunTransitionCause, 'wait'>;

type TerminalTransitionCause = Extract<RunTransitionCause, 'lifecycle'>;

export interface RunPhaseState {
  readonly phase: RunPhase;
  readonly substate?: RunSubstate;
  /**
   * Epoch ms when the run entered its current active phase. Held across
   * substate changes, cleared when the phase stops being active, and stamped
   * again on a later WAITING→RUNNING transition. Hosts render
   * elapsed-while-active time from this value. This is not durable run
   * creation time; that is `RunView.launchedAt`.
   * `RunHandle.startedAt` separately timestamps a handle generation
   * and may remain present on a parked handle after this field has cleared.
   */
  readonly runStartedAt?: number;
}

/**
 * One entry per run, in one of its two forms. A hold is not a second
 * structure overlaying the phase: it is the entry itself, carrying its detail
 * and any phase already known, so every reader sees the same state without
 * merging two collections.
 */
type RunEntry =
  | { readonly kind: 'phase'; readonly state: RunPhaseState }
  | {
      /**
       * Classification could not settle on a phase (held by another process,
       * or the run state unreadable). RUNNING/WAITING mean a live flow in this
       * process, and this process never adopts anyone else's run, so a hold
       * with no prior phase has no phase to publish: it is written to the
       * session's local runtime snapshot (`unreadable`, PRD 5.1), which the
       * fold reads as `readOnly` and `statusDetail`.
       */
      readonly kind: 'hold';
      readonly detail: string;
      readonly state?: RunPhaseState;
    };

export class RunStatusMachine {
  private readonly runs = new Map<RunId, RunEntry>();

  /**
   * @param publishStatus Where this machine publishes canonical `status`
   *   facts after launch: every non-terminal transition (the terminal phase
   *   is the `run.end` row's). Creation batches the initial status with run.start.
   *   Every consumer, including the transcript recorder (via its `handleStatus`
   *   port), reads it. The session constructs the machine with its own
   *   publisher, so a transition reaches every consumer no matter which
   *   caller triggered it. Required and never rebound: a machine publishing
   *   where nobody listens is a status plane that silently loses every
   *   transition.
   * @param setUnreadable Where a hold lands: the session's local runtime
   *   snapshot, with the hold's detail or null when the hold is dropped.
   */
  constructor(
    private readonly publishStatus: (event: StatusEvent) => void,
    private readonly setUnreadable: (
      runId: RunId,
      detail: string | null,
    ) => void,
  ) {}

  get(runId: RunId): RunPhase | undefined {
    return this.getRunState(runId)?.phase;
  }

  /**
   * This run's combined phase + substate + run-window start. The entry is
   * written before the matching `status` fact is published, so a consumer
   * reacting to that fact reads the phase the fact announced without mirroring
   * it, and `getAllRunStates()` stays for the whole-map cases.
   */
  getRunState(runId: RunId): RunPhaseState | undefined {
    return this.runs.get(runId)?.state;
  }

  getSubstate(runId: RunId): RunSubstate | undefined {
    return this.getRunState(runId)?.substate;
  }

  transition(
    runId: RunId,
    to: RunPhase,
    cause: RunTransitionCause,
    options: RunStatusEmitOptions = {},
  ): boolean {
    const entry = this.runs.get(runId);
    const overwritesHold = entry?.kind === 'hold';
    const previousState = entry?.state;
    const from = previousState?.phase;
    if (!canTransitionRunPhase(from, to, cause)) return false;

    // The table decides whether a transition is permitted, but not whether a
    // permitted transition changes state. A steady RUNNING resume with no
    // substate to clear must stay silent, while a real substate clear still
    // writes and publishes from this single status owner. A hold is never
    // such a no-op: even when the phase it retained equals `to`, the entry is
    // still a hold, so it has to convert through the write-and-publish path
    // below or the run stays read-only while this reports success.
    if (
      !overwritesHold &&
      from === to &&
      previousState?.substate === options.substate
    ) {
      return true;
    }
    // The run window opens on the first active phase and survives every
    // substate change and active→active transition after it; anything that is
    // not an active phase closes it. Stamped here because this is the only
    // writer of the phase it derives from.
    const runStartedAt = isActivePhase(to)
      ? (previousState?.runStartedAt ?? Date.now())
      : undefined;
    this.runs.set(runId, {
      kind: 'phase',
      state: {
        phase: to,
        ...(options.substate ? { substate: options.substate } : {}),
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      },
    });
    // A terminal phase is the `run.end` row's fact (one run model, section
    // 3.3), written once by `finalizeRun`. The machine records it for its
    // in-process readers — `get`, `getRunState`, `isInFlight`,
    // `getAllRunStates` — and publishes no second copy, so every `status` row
    // this machine emits is non-terminal and no consumer may wait on one to
    // close a run out: the terminal row to fold is `run.end`.
    if (!isTerminalOutcomePhase(to)) {
      this.publishTransition(runId, to, {
        ...options,
        cause,
        ...(from ? { previousPhase: from } : {}),
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      });
    }
    // A phase that replaces a hold also drops that hold's detail, and the
    // status fact above carries no detail of its own.
    if (overwritesHold) this.publishHoldChanged(runId);
    return true;
  }

  transitionToWaiting(
    runId: RunId,
    cause: WaitingTransitionCause,
    options: RunStatusEmitOptions = {},
  ): boolean {
    if (this.transition(runId, RUN_PHASE.WAITING, cause, options)) {
      return true;
    }
    if (
      !this.transition(
        runId,
        RUN_PHASE.RUNNING,
        RUN_TRANSITION_CAUSE.RESUME,
        options,
      )
    ) {
      return false;
    }
    return this.transition(runId, RUN_PHASE.WAITING, cause, options);
  }

  /**
   * Drive a run to a terminal phase, escalating through the RUNNING
   * choreography the table requires. `cause` is the caller's own reason, so
   * every terminal writer shares this single ladder rather than carrying a
   * copy of it.
   */
  transitionToTerminal(
    runId: RunId,
    to: RunPhase,
    cause: TerminalTransitionCause,
    options: RunStatusEmitOptions = {},
  ): boolean {
    const current = this.get(runId);
    if (current === to) {
      return true;
    }
    if (this.transition(runId, to, cause, options)) {
      return true;
    }
    if (current === undefined || current === RUN_PHASE.WAITING) {
      const resumeCause =
        current === undefined
          ? RUN_TRANSITION_CAUSE.LIFECYCLE
          : RUN_TRANSITION_CAUSE.RESUME;
      return (
        this.transition(runId, RUN_PHASE.RUNNING, resumeCause, options) &&
        this.transition(runId, to, cause, options)
      );
    }
    return false;
  }

  /**
   * Record why this run cannot be settled. A hold already carrying this
   * detail is left as it is, so a repeated report neither rewrites the entry
   * nor republishes the same hold.
   *
   * A written hold publishes, exactly like a transition does: it is a fact a
   * user action can produce while hosts are attached, so nothing may wait for
   * an unrelated metadata sync to repaint the tab.
   */
  markUnavailable(runId: RunId, detail: string): void {
    const entry = this.runs.get(runId);
    if (entry?.kind === 'hold' && entry.detail === detail) return;
    const state = entry?.state;
    this.runs.set(runId, {
      kind: 'hold',
      detail,
      ...(state ? { state } : {}),
    });
    this.publishHoldChanged(runId);
  }

  /**
   * Drop a hold together with the phase it retained. The callers that open a
   * run for write call this when they finish without writing a phase — a
   * resume that reattaches, and a follow-up the session refuses; a
   * `transition` that does write replaces the hold with the phase it lands on.
   *
   * A hold written after a failed tool-use resume carries the WAITING its
   * rollback left, and every caller has just re-read the run and found it
   * finished or merely resumable, which disproves that phase: restoring it
   * would show a live run this process does not have.
   */
  clearHold(runId: RunId): void {
    if (this.runs.get(runId)?.kind !== 'hold') return;
    this.runs.delete(runId);
    this.publishHoldChanged(runId);
  }

  /** The detail recorded by `markUnavailable`, if the run has no phase here. */
  holdState(runId: RunId): string | undefined {
    const entry = this.runs.get(runId);
    return entry?.kind === 'hold' ? entry.detail : undefined;
  }

  clearRun(runId: RunId): void {
    this.runs.delete(runId);
  }

  /** Combined per-run phase + substate for every known run. */
  getAllRunStates(): Map<RunId, RunPhaseState> {
    const values = new Map<RunId, RunPhaseState>();
    for (const [runId, entry] of this.runs) {
      if (entry.state) values.set(runId, entry.state);
    }
    return values;
  }

  isInFlight(runId: RunId): boolean {
    return isInFlightPhase(this.get(runId));
  }

  /**
   * Write this run's hold, or its release, to the session's local runtime
   * snapshot. A hold has no phase, so it cannot ride the `status` fact; the
   * fold reads it as `readOnly` with the detail as `statusDetail` (PRD 5.1).
   */
  private publishHoldChanged(runId: RunId): void {
    this.setUnreadable(runId, this.holdState(runId) ?? null);
  }

  /** Emit one non-terminal `status` fact; the terminal phase never gets one. */
  private publishTransition(
    runId: RunId,
    phase: RunPhase,
    options: RunStatusEmitOptions & {
      cause: RunTransitionCause;
      previousPhase?: RunPhase;
      runStartedAt?: number;
    },
  ): void {
    this.publishStatus({
      type: 'status',
      runId,
      phase,
      cause: options.cause,
      ...(options.previousPhase
        ? { previousPhase: options.previousPhase }
        : {}),
      ...(options.substate ? { substate: options.substate } : {}),
      ...(options.runStartedAt !== undefined
        ? { runStartedAt: options.runStartedAt }
        : {}),
    });
  }
}
