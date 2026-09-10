import type { StatusEvent } from '@agent/trace';
import {
  STREAM_PHASE,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
} from '@shared/schemas';
import {
  canTransitionStreamPhase,
  isActivePhase,
  isInFlightPhase,
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';

interface StreamStatusEmitOptions {
  substate?: StreamSubstate;
}

type WaitingTransitionCause = Extract<StreamTransitionCause, 'wait'>;

type TerminalTransitionCause = Extract<StreamTransitionCause, 'lifecycle'>;

export interface StreamPhaseState {
  readonly phase: StreamPhase;
  readonly substate?: StreamSubstate;
  /**
   * Epoch ms when the stream entered its current active phase. Held across
   * substate changes, cleared when the phase stops being active, and stamped
   * again on a later WAITING→RUNNING transition. Hosts render
   * elapsed-while-active time from this value. This is not durable execution
   * creation time; that is `ExecutionMeta.timestamp`.
   * `AgentExecutionHandle.startedAt` separately timestamps a handle generation
   * and may remain present on a parked handle after this field has cleared.
   */
  readonly runStartedAt?: number;
}

/**
 * One entry per stream, in one of its two forms. A hold is not a second
 * structure overlaying the phase: it is the entry itself, carrying its detail
 * and any phase already known, so every reader sees the same state without
 * merging two collections.
 */
type StreamEntry =
  | { readonly kind: 'phase'; readonly state: StreamPhaseState }
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
      readonly state?: StreamPhaseState;
    };

export class StreamStatusMachine {
  private readonly streams = new Map<StreamTabId, StreamEntry>();

  /**
   * @param publishStatus Where this machine publishes canonical `status`
   *   facts after launch. Creation batches the initial status with run.start.
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
      stream: StreamTabId,
      detail: string | null,
    ) => void,
  ) {}

  get(stream: StreamTabId): StreamPhase | undefined {
    return this.getStreamState(stream)?.phase;
  }

  /**
   * This stream's combined phase + substate + run-window start. The entry is
   * written before the matching `status` fact is published, so a consumer
   * reacting to that fact reads the phase the fact announced without mirroring
   * it, and `getAllStreamStates()` stays for the whole-map cases.
   */
  getStreamState(stream: StreamTabId): StreamPhaseState | undefined {
    return this.streams.get(stream)?.state;
  }

  getSubstate(stream: StreamTabId): StreamSubstate | undefined {
    return this.getStreamState(stream)?.substate;
  }

  transition(
    stream: StreamTabId,
    to: StreamPhase,
    cause: StreamTransitionCause,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const entry = this.streams.get(stream);
    const overwritesHold = entry?.kind === 'hold';
    const previousState = entry?.state;
    const from = previousState?.phase;
    if (!canTransitionStreamPhase(from, to, cause)) return false;

    // The table decides whether a transition is permitted, but not whether a
    // permitted transition changes state. A steady RUNNING resume with no
    // substate to clear must stay silent, while a real substate clear still
    // writes and publishes from this single status owner. A hold is never
    // such a no-op: even when the phase it retained equals `to`, the entry is
    // still a hold, so it has to convert through the write-and-publish path
    // below or the stream stays read-only while this reports success.
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
    this.streams.set(stream, {
      kind: 'phase',
      state: {
        phase: to,
        ...(options.substate ? { substate: options.substate } : {}),
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      },
    });
    this.publishTransition(stream, to, {
      ...options,
      cause,
      ...(from ? { previousPhase: from } : {}),
      ...(runStartedAt !== undefined ? { runStartedAt } : {}),
    });
    // A phase that replaces a hold also drops that hold's detail, and the
    // status fact above carries no detail of its own.
    if (overwritesHold) this.publishHoldChanged(stream);
    return true;
  }

  transitionToWaiting(
    stream: StreamTabId,
    cause: WaitingTransitionCause,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    if (this.transition(stream, STREAM_PHASE.WAITING, cause, options)) {
      return true;
    }
    if (
      !this.transition(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_TRANSITION_CAUSE.RESUME,
        options,
      )
    ) {
      return false;
    }
    return this.transition(stream, STREAM_PHASE.WAITING, cause, options);
  }

  /**
   * Drive a stream to a terminal phase, escalating through the RUNNING
   * choreography the table requires. `cause` is the caller's own reason, so
   * every terminal writer shares this single ladder rather than carrying a
   * copy of it.
   */
  transitionToTerminal(
    stream: StreamTabId,
    to: StreamPhase,
    cause: TerminalTransitionCause,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const current = this.get(stream);
    if (current === to) {
      return true;
    }
    if (this.transition(stream, to, cause, options)) {
      return true;
    }
    if (current === undefined || current === STREAM_PHASE.WAITING) {
      const resumeCause =
        current === undefined
          ? STREAM_TRANSITION_CAUSE.LIFECYCLE
          : STREAM_TRANSITION_CAUSE.RESUME;
      return (
        this.transition(stream, STREAM_PHASE.RUNNING, resumeCause, options) &&
        this.transition(stream, to, cause, options)
      );
    }
    return false;
  }

  /**
   * Record why this stream cannot be settled. A hold already carrying this
   * detail is left as it is, so a repeated report neither rewrites the entry
   * nor republishes the same hold.
   *
   * A written hold publishes, exactly like a transition does: it is a fact a
   * user action can produce while hosts are attached, so nothing may wait for
   * an unrelated metadata sync to repaint the tab.
   */
  markUnavailable(stream: StreamTabId, detail: string): void {
    const entry = this.streams.get(stream);
    if (entry?.kind === 'hold' && entry.detail === detail) return;
    const state = entry?.state;
    this.streams.set(stream, {
      kind: 'hold',
      detail,
      ...(state ? { state } : {}),
    });
    this.publishHoldChanged(stream);
  }

  /**
   * Drop a hold, restoring the phase it retained. The callers that open a run
   * for write call this when they finish without writing a phase — a resume
   * that reattaches, and a follow-up the session refuses; a `transition` that
   * does write replaces the hold with the phase it lands on.
   *
   * `discardRetainedPhase` drops that retained phase with the hold. A hold
   * written after a failed tool-use resume carries the WAITING its rollback
   * left, and a caller that has just re-read the run and found it finished or
   * merely resumable has disproved that phase: restoring it would show a live
   * run this process does not have. A caller that learned nothing new about
   * the phase keeps the default.
   */
  clearHold(
    stream: StreamTabId,
    options: { discardRetainedPhase?: boolean } = {},
  ): void {
    const entry = this.streams.get(stream);
    if (entry?.kind !== 'hold') return;
    if (entry.state && !options.discardRetainedPhase) {
      this.streams.set(stream, { kind: 'phase', state: entry.state });
    } else {
      this.streams.delete(stream);
    }
    this.publishHoldChanged(stream);
  }

  /** The detail recorded by `markUnavailable`, if the stream has no phase here. */
  holdState(stream: StreamTabId): string | undefined {
    const entry = this.streams.get(stream);
    return entry?.kind === 'hold' ? entry.detail : undefined;
  }

  clearStream(stream: StreamTabId): void {
    this.streams.delete(stream);
  }

  clearAll(): void {
    this.streams.clear();
  }

  /** Combined per-stream phase + substate for every known stream. */
  getAllStreamStates(): Map<StreamTabId, StreamPhaseState> {
    const values = new Map<StreamTabId, StreamPhaseState>();
    for (const [stream, entry] of this.streams) {
      if (entry.state) values.set(stream, entry.state);
    }
    return values;
  }

  isInFlight(stream: StreamTabId): boolean {
    return isInFlightPhase(this.get(stream));
  }

  /**
   * Write this stream's hold, or its release, to the session's local runtime
   * snapshot. A hold has no phase, so it cannot ride the `status` fact; the
   * fold reads it as `readOnly` with the detail as `statusDetail` (PRD 5.1).
   */
  private publishHoldChanged(stream: StreamTabId): void {
    this.setUnreadable(stream, this.holdState(stream) ?? null);
  }

  private publishTransition(
    stream: StreamTabId,
    phase: StreamPhase,
    options: StreamStatusEmitOptions & {
      cause: StreamTransitionCause;
      previousPhase?: StreamPhase;
      runStartedAt?: number;
    },
  ): void {
    this.publishStatus({
      type: 'status',
      streamId: stream,
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
