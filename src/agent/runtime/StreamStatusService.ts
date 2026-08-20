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

type WaitingTransitionCause = Extract<
  StreamTransitionCause,
  'wait' | 'restart-repair'
>;

type TerminalTransitionCause = Extract<
  StreamTransitionCause,
  'lifecycle' | 'restart-repair'
>;

export interface StreamPhaseState {
  readonly phase: StreamPhase;
  readonly substate?: StreamSubstate;
  /**
   * Epoch ms when the stream entered its current active phase, held across
   * substate changes and cleared the moment the phase stops being active.
   * The one owner of "when did this run start" — hosts render elapsed time
   * from it instead of each stamping a clock read of their own.
   */
  readonly runStartedAt?: number;
}

/**
 * One entry per stream, in either of its two forms. A reservation is not a
 * second structure overlaying the phase: it is the entry itself, carrying the
 * state a rollback must restore, so every reader sees the same state without
 * merging two collections.
 */
type StreamEntry =
  | { readonly kind: 'phase'; readonly state: StreamPhaseState }
  | {
      readonly kind: 'reserved';
      readonly runStartedAt: number;
      readonly rollbackTo?: StreamPhaseState;
    };

function effectiveState(entry: StreamEntry): StreamPhaseState {
  return entry.kind === 'reserved'
    ? {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
        runStartedAt: entry.runStartedAt,
      }
    : entry.state;
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
    return this.stateFor(stream)?.phase;
  }

  /** Opaque identity replaced whenever this stream's status entry changes. */
  getGeneration(stream: StreamTabId): object | undefined {
    return this.streams.get(stream);
  }

  /** Whether an earlier status read, including absence, is still current. */
  isCurrentGeneration(
    stream: StreamTabId,
    generation: object | undefined,
  ): boolean {
    return this.streams.get(stream) === generation;
  }

  getSubstate(stream: StreamTabId): StreamSubstate | undefined {
    return this.stateFor(stream)?.substate;
  }

  tryAcquire(
    stream: StreamTabId,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const entry = this.streams.get(stream);
    if (entry?.kind === 'reserved') return false;
    const previousPhase = entry?.state.phase;
    if (!canAcquireStreamReservation(previousPhase)) {
      return false;
    }
    // A reservation is only acquirable from a non-active phase, so it always
    // opens a fresh run window rather than extending an earlier one.
    const runStartedAt = Date.now();
    this.streams.set(stream, {
      kind: 'reserved',
      runStartedAt,
      ...(entry ? { rollbackTo: entry.state } : {}),
    });
    this.publishStatus(stream, STREAM_PHASE.RUNNING, {
      ...options,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
      ...(previousPhase ? { previousPhase } : {}),
      substate: STREAM_SUBSTATE.STARTING,
      runStartedAt,
    });
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
    const previousState = fromReservation ? entry.rollbackTo : entry?.state;
    const from = previousState?.phase;
    let tableFrom: StreamPhase | undefined;
    if (!fromReservation) {
      tableFrom = from;
    } else if (to === STREAM_PHASE.RUNNING) {
      tableFrom = undefined;
    } else {
      tableFrom = STREAM_PHASE.RUNNING;
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

  clearStream(stream: StreamTabId): void {
    this.streams.delete(stream);
  }

  clearAll(): void {
    this.streams.clear();
  }

  entries(): IterableIterator<[StreamTabId, StreamPhase]> {
    const phases = new Map<StreamTabId, StreamPhase>();
    for (const [stream, state] of this.getAllStreamStates()) {
      phases.set(stream, state.phase);
    }
    return phases.entries();
  }

  /**
   * Combined per-stream phase + substate, including in-flight reservations.
   * `entries()` is a thin phase-only projection of this, so the two views can
   * never diverge on which streams they cover.
   */
  getAllStreamStates(): Map<StreamTabId, StreamPhaseState> {
    const values = new Map<StreamTabId, StreamPhaseState>();
    for (const [stream, entry] of this.streams) {
      values.set(stream, effectiveState(entry));
    }
    return values;
  }

  isActiveOrResuming(stream: StreamTabId): boolean {
    return isActivePhase(this.get(stream));
  }

  isInFlight(stream: StreamTabId): boolean {
    return isInFlightPhase(this.get(stream));
  }

  private stateFor(stream: StreamTabId): StreamPhaseState | undefined {
    const entry = this.streams.get(stream);
    return entry ? effectiveState(entry) : undefined;
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
