import type { AgentTrace, StatusEvent } from '@agent/trace';
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

export interface StreamStatusChange {
  streamId: StreamTabId;
  status: StreamPhase;
  previousStatus?: StreamPhase;
  cause: StreamTransitionCause;
  substate?: StreamSubstate;
}

export interface StreamStatusEmitOptions {
  events?: SessionEventHub;
  trace?: AgentTrace;
  substate?: StreamSubstate;
}

type WaitingTransitionCause = Extract<
  StreamTransitionCause,
  'wait' | 'restart-repair'
>;

export interface StreamPhaseState {
  readonly phase: StreamPhase;
  readonly substate?: StreamSubstate;
}

function projectStatusEvent(event: StatusEvent): StreamStatusChange {
  return {
    streamId: event.streamId,
    status: event.phase,
    ...(event.previousPhase ? { previousStatus: event.previousPhase } : {}),
    cause: event.cause,
    ...(event.substate ? { substate: event.substate } : {}),
  };
}

export class StreamStatusMachine {
  private readonly phases = new Map<StreamTabId, StreamPhaseState>();
  private readonly reservations = new Set<StreamTabId>();
  private readonly statusListeners = new Set<
    (change: StreamStatusChange) => void
  >();

  get(stream: StreamTabId): StreamPhase | undefined {
    return this.stateFor(stream)?.phase;
  }

  getSubstate(stream: StreamTabId): StreamSubstate | undefined {
    return this.stateFor(stream)?.substate;
  }

  tryAcquire(
    stream: StreamTabId,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    if (this.reservations.has(stream)) return false;
    const previousPhase = this.phases.get(stream)?.phase;
    if (!canAcquireStreamReservation(previousPhase)) {
      return false;
    }
    this.reservations.add(stream);
    this.publishStatus(stream, STREAM_PHASE.RUNNING, {
      ...options,
      cause: STREAM_TRANSITION_CAUSE.LIFECYCLE,
      ...(previousPhase ? { previousPhase } : {}),
      substate: STREAM_SUBSTATE.STARTING,
    });
    return true;
  }

  releaseIfReserved(
    stream: StreamTabId,
    options: StreamStatusEmitOptions = {},
  ): void {
    if (!this.reservations.has(stream)) return;
    const rollbackPhase =
      this.phases.get(stream)?.phase ?? STREAM_PHASE.CANCELLED;
    if (
      this.transition(
        stream,
        rollbackPhase,
        STREAM_TRANSITION_CAUSE.LIFECYCLE,
        options,
      )
    ) {
      return;
    }
    this.reservations.delete(stream);
  }

  transition(
    stream: StreamTabId,
    to: StreamPhase,
    cause: StreamTransitionCause,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const previousState = this.phases.get(stream);
    const from = previousState?.phase;
    const fromReservation = this.reservations.has(stream);
    let tableFrom: StreamPhase | undefined;
    if (!fromReservation) {
      tableFrom = from;
    } else if (to === STREAM_PHASE.RUNNING) {
      tableFrom = undefined;
    } else {
      tableFrom = STREAM_PHASE.RUNNING;
    }
    if (!canTransitionStreamPhase(tableFrom, to, cause)) return false;

    this.reservations.delete(stream);
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
    this.phases.set(stream, {
      phase: to,
      ...(options.substate ? { substate: options.substate } : {}),
    });
    const previousPhase = fromReservation ? STREAM_PHASE.RUNNING : from;
    this.publishStatus(stream, to, {
      ...options,
      cause,
      ...(previousPhase ? { previousPhase } : {}),
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

  transitionToTerminal(
    stream: StreamTabId,
    to: StreamPhase,
    options: StreamStatusEmitOptions = {},
  ): boolean {
    const current = this.get(stream);
    if (current === to) {
      return true;
    }
    if (
      this.transition(stream, to, STREAM_TRANSITION_CAUSE.LIFECYCLE, options)
    ) {
      return true;
    }
    if (current === undefined) {
      return (
        this.transition(
          stream,
          STREAM_PHASE.RUNNING,
          STREAM_TRANSITION_CAUSE.LIFECYCLE,
          options,
        ) &&
        this.transition(stream, to, STREAM_TRANSITION_CAUSE.LIFECYCLE, options)
      );
    }
    if (current !== STREAM_PHASE.WAITING) {
      return false;
    }
    return (
      this.transition(
        stream,
        STREAM_PHASE.RUNNING,
        STREAM_TRANSITION_CAUSE.RESUME,
        options,
      ) &&
      this.transition(stream, to, STREAM_TRANSITION_CAUSE.LIFECYCLE, options)
    );
  }

  clearStream(stream: StreamTabId): void {
    this.reservations.delete(stream);
    this.phases.delete(stream);
  }

  clearAll(): void {
    this.reservations.clear();
    this.phases.clear();
  }

  entries(): IterableIterator<[StreamTabId, StreamPhase]> {
    return this.getAll().entries();
  }

  /**
   * Combined per-stream phase + substate, merging in in-flight reservations
   * exactly once. `getAll()` and `getAllSubstates()` are thin projections of
   * this so the two views can never diverge on which streams they cover.
   */
  getAllStreamStates(): Map<StreamTabId, StreamPhaseState> {
    const values = new Map<StreamTabId, StreamPhaseState>();
    for (const [stream, state] of this.phases) {
      values.set(stream, state);
    }
    for (const stream of this.reservations) {
      values.set(stream, {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
      });
    }
    return values;
  }

  getAll(): Map<StreamTabId, StreamPhase> {
    const values = new Map<StreamTabId, StreamPhase>();
    for (const [stream, state] of this.getAllStreamStates()) {
      values.set(stream, state.phase);
    }
    return values;
  }

  getAllSubstates(): Map<StreamTabId, StreamSubstate> {
    const values = new Map<StreamTabId, StreamSubstate>();
    for (const [stream, state] of this.getAllStreamStates()) {
      if (state.substate) {
        values.set(stream, state.substate);
      }
    }
    return values;
  }

  has(stream: StreamTabId): boolean {
    return this.phases.has(stream) || this.reservations.has(stream);
  }

  isActiveOrResuming(stream: StreamTabId): boolean {
    return isActivePhase(this.get(stream));
  }

  isInFlight(stream: StreamTabId): boolean {
    return isInFlightPhase(this.get(stream));
  }

  onDidChange(listener: (change: StreamStatusChange) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private stateFor(stream: StreamTabId): StreamPhaseState | undefined {
    if (this.reservations.has(stream)) {
      return {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
      };
    }
    return this.phases.get(stream);
  }

  private publishStatus(
    stream: StreamTabId,
    phase: StreamPhase,
    options: StreamStatusEmitOptions & {
      cause: StreamTransitionCause;
      previousPhase?: StreamPhase;
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
    };
    options.trace?.emit(event);

    const change = projectStatusEvent(event);
    if (!options.trace && options.events) {
      options.events.emit({
        scope: 'session',
        event: {
          type: 'updateStreamStatus',
          payload: change,
        },
      });
    }
    for (const listener of this.statusListeners) {
      listener(change);
    }
  }
}
