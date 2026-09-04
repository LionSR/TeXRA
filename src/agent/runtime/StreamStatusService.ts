import type { StatusEvent } from '@agent/trace';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
} from '@shared/schemas';
import {
  canAcquireStreamReservation,
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

type TerminalTransitionCause = Extract<
  StreamTransitionCause,
  'lifecycle' | 'restart-repair'
>;

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
 * One entry per stream, in one of its three forms. Neither a reservation nor a
 * hold is a second structure overlaying the phase: each is the entry itself
 * (a reservation carrying the state a rollback must restore, a hold carrying
 * its detail and any phase already known), so every reader sees the same state
 * without merging two collections.
 */
type StreamEntry =
  | { readonly kind: 'phase'; readonly state: StreamPhaseState }
  | {
      readonly kind: 'reserved';
      readonly runStartedAt: number;
      readonly rollbackTo?: StreamPhaseState;
    }
  | {
      /**
       * Classification could not settle on a phase (held by another process,
       * or the run state unreadable). RUNNING/WAITING mean a live flow in this
       * process, and this process never adopts anyone else's run, so a hold
       * with no prior phase has no phase to publish — the `streamHoldChanged`
       * fact carries the change instead, and hosts re-read the resolved phase.
       */
      readonly kind: 'hold';
      readonly detail: string;
      readonly state?: StreamPhaseState;
    };

function effectiveState(entry: StreamEntry): StreamPhaseState | undefined {
  switch (entry.kind) {
    case 'phase':
      return entry.state;
    case 'reserved':
      return {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
        runStartedAt: entry.runStartedAt,
      };
    case 'hold':
      return entry.state;
  }
}

export class StreamStatusMachine {
  private readonly streams = new Map<StreamTabId, StreamEntry>();

  /**
   * @param eventHub Session hub this machine publishes canonical `status` facts
   *   on — the ONLY status rail; every consumer, including the transcript
   *   recorder (via its `handleStatus` port), reads it. The session constructs
   *   both and hands the hub over once, so a transition reaches every consumer
   *   no matter which caller triggered it. It is required and never rebound: a
   *   machine publishing where nobody listens is a status plane that silently
   *   loses every transition.
   */
  constructor(private readonly eventHub: SessionEventHub) {}

  get(stream: StreamTabId): StreamPhase | undefined {
    return this.getStreamState(stream)?.phase;
  }

  /**
   * This stream's combined phase + substate + run-window start, including an
   * in-flight reservation. The per-stream read every host renders from: the
   * entry is written before the matching `status` fact is published, so a
   * consumer reacting to that fact reads the phase the fact announced without
   * mirroring it, and `getAllStreamStates()` stays for the whole-map cases.
   */
  getStreamState(stream: StreamTabId): StreamPhaseState | undefined {
    const entry = this.streams.get(stream);
    return entry ? effectiveState(entry) : undefined;
  }

  /** Opaque identity replaced whenever this stream's status entry changes. */
  getGeneration(stream: StreamTabId): object | undefined {
    return this.streams.get(stream);
  }

  getSubstate(stream: StreamTabId): StreamSubstate | undefined {
    return this.getStreamState(stream)?.substate;
  }

  tryAcquire(
    stream: StreamTabId,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const entry = this.streams.get(stream);
    if (entry?.kind === 'reserved') return false;
    const previousState = entry ? effectiveState(entry) : undefined;
    const previousPhase = previousState?.phase;
    if (!canAcquireStreamReservation(previousPhase)) {
      return false;
    }
    // A reservation is only acquirable from a non-active phase, so it always
    // opens a fresh run window rather than extending an earlier one.
    const runStartedAt = Date.now();
    this.streams.set(stream, {
      kind: 'reserved',
      runStartedAt,
      ...(previousState ? { rollbackTo: previousState } : {}),
    });
    this.publishStatus(stream, STREAM_PHASE.RUNNING, {
      ...options,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
      ...(previousPhase ? { previousPhase } : {}),
      substate: STREAM_SUBSTATE.STARTING,
      runStartedAt,
    });
    // A reservation that replaces a hold also drops that hold's detail.
    if (entry?.kind === 'hold') this.publishHoldChanged(stream);
    return true;
  }

  releaseIfReserved(
    stream: StreamTabId,
    options: StreamStatusEmitOptions = {},
  ): void {
    const entry = this.streams.get(stream);
    if (entry?.kind !== 'reserved') return;
    const rollbackPhase = entry.rollbackTo?.phase ?? STREAM_PHASE.CANCELLED;
    if (
      this.transition(
        stream,
        rollbackPhase,
        STREAM_TRANSITION_CAUSE.RESERVATION_ROLLBACK,
        options,
      )
    ) {
      return;
    }
    // The rollback the table refused still has to drop the reservation, so the
    // stream returns to exactly the state the reservation overlaid.
    if (entry.rollbackTo) {
      this.streams.set(stream, { kind: 'phase', state: entry.rollbackTo });
      return;
    }
    this.streams.delete(stream);
  }

  transition(
    stream: StreamTabId,
    to: StreamPhase,
    cause: StreamTransitionCause,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const entry = this.streams.get(stream);
    const fromReservation = entry?.kind === 'reserved';
    const overwritesHold = entry?.kind === 'hold';
    let previousState: StreamPhaseState | undefined;
    if (fromReservation) previousState = entry.rollbackTo;
    else if (entry) previousState = effectiveState(entry);
    const from = previousState?.phase;
    let tableFrom = from;
    if (fromReservation) {
      tableFrom =
        to === STREAM_PHASE.RUNNING ? undefined : STREAM_PHASE.RUNNING;
    }
    if (!canTransitionStreamPhase(tableFrom, to, cause)) return false;

    // The table decides whether a transition is permitted, but not whether a
    // permitted transition changes state. A steady RUNNING resume with no
    // substate to clear must stay silent, while a real substate clear still
    // writes and publishes from this single status owner.
    if (
      !fromReservation &&
      from === to &&
      previousState?.substate === options.substate
    ) {
      return true;
    }
    // The run window opens on the first active phase and survives every
    // substate change and active→active transition after it; anything that is
    // not an active phase closes it. Stamped here because this is the only
    // writer of the phase it derives from.
    const previousRunStartedAt = fromReservation
      ? entry.runStartedAt
      : previousState?.runStartedAt;
    const runStartedAt = isActivePhase(to)
      ? (previousRunStartedAt ?? Date.now())
      : undefined;
    this.streams.set(stream, {
      kind: 'phase',
      state: {
        phase: to,
        ...(options.substate ? { substate: options.substate } : {}),
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      },
    });
    const previousPhase = fromReservation ? STREAM_PHASE.RUNNING : from;
    this.publishStatus(stream, to, {
      ...options,
      cause,
      ...(previousPhase ? { previousPhase } : {}),
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
   * choreography the table requires. `cause` is the caller's own reason —
   * restart repair and the run lifecycle share this single ladder rather than
   * each carrying a copy of it.
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
   * Record why restart classification could not settle this stream. Returns
   * `false` without writing when a live reservation owns the stream: a hold
   * describes a run some earlier process left behind, which a reservation has
   * by definition superseded, and overwriting one strands the tab — a hold is
   * not `reserved`, so `releaseIfReserved` becomes a no-op and a failed
   * launch's rollback never runs, while the RUNNING the hold inherits from
   * `effectiveState` blocks every later `tryAcquire`. Holds lived in a side
   * map before they became an entry arm and could not do this. The caller
   * logs the refusal so the skipped hold is not silent.
   *
   * A written hold publishes, exactly like a transition does: it is a fact a
   * user action can produce while hosts are attached, so nothing may wait for
   * an unrelated metadata sync to repaint the tab.
   */
  markUnavailable(stream: StreamTabId, detail: string): boolean {
    const entry = this.streams.get(stream);
    if (entry?.kind === 'reserved') return false;
    const state = entry ? effectiveState(entry) : undefined;
    if (entry?.kind === 'hold' && entry.detail === detail) return true;
    this.streams.set(stream, {
      kind: 'hold',
      detail,
      ...(state ? { state } : {}),
    });
    this.publishHoldChanged(stream);
    return true;
  }

  /**
   * Drop a hold. Restart repair calls this when a classification resolves
   * without writing a phase; a `transition` that does write replaces the hold
   * with the phase it lands on.
   */
  clearHold(stream: StreamTabId): void {
    const entry = this.streams.get(stream);
    if (entry?.kind !== 'hold') return;
    if (entry.state) {
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

  /** Combined per-stream phase + substate, including in-flight reservations. */
  getAllStreamStates(): Map<StreamTabId, StreamPhaseState> {
    const values = new Map<StreamTabId, StreamPhaseState>();
    for (const [stream, entry] of this.streams) {
      const state = effectiveState(entry);
      if (state) values.set(stream, state);
    }
    return values;
  }

  isInFlight(stream: StreamTabId): boolean {
    return isInFlightPhase(this.get(stream));
  }

  /**
   * Announce that this stream's hold was recorded or dropped. A hold has no
   * phase, so it cannot ride the `status` fact; hosts react by re-reading the
   * stream's resolved phase, which is where the hold's detail is rendered.
   */
  private publishHoldChanged(stream: StreamTabId): void {
    this.eventHub.emit({
      scope: 'session',
      event: { type: 'streamHoldChanged', payload: { streamId: stream } },
    });
  }

  private publishStatus(
    stream: StreamTabId,
    phase: StreamPhase,
    options: StreamStatusEmitOptions & {
      cause: StreamTransitionCause;
      previousPhase?: StreamPhase;
      runStartedAt?: number;
    },
  ): void {
    const event: StatusEvent = {
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
    };
    this.eventHub.emit({
      scope: 'session',
      event,
    });
  }
}
