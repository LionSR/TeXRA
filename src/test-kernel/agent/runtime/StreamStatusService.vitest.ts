// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { TraceEmitter, type StatusEvent } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import {
  canTransitionStreamPhase,
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';
import { seedStreamStatusForTest } from '@test/support/streamStatusTestUtils';

// Local file imports
import {
  recordSessionEvents,
  runEventsOfType,
  sessionFactsOfType,
} from '../progressTestUtils';

/** Fresh registry + recording host, keyed to a per-test stream id. */
function setupMachine(streamId: string): {
  machine: StreamStatusMachine;
  statusEvents: () => StatusEvent[];
  streamId: StreamTabId;
} {
  const events = new SessionEventHub();
  const published = recordSessionEvents(events, { scope: 'session' });
  return {
    machine: new StreamStatusMachine(events),
    statusEvents: () => sessionFactsOfType(published.events, 'status'),
    streamId: streamId as StreamTabId,
  };
}

describe('StreamStatusMachine', () => {
  const phases = Object.values(STREAM_PHASE) as StreamPhase[];
  const causes = Object.values(
    STREAM_TRANSITION_CAUSE,
  ) as StreamTransitionCause[];

  it('keeps stream status state per instance', () => {
    const first = new StreamStatusMachine();
    const second = new StreamStatusMachine();
    const streamId = 'stream-status-instance-test' as StreamTabId;

    seedStreamStatusForTest(first, streamId, STREAM_PHASE.WAITING);

    expect(first.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(second.get(streamId)).toBeUndefined();
  });

  it('publishes only through its owning session hub', () => {
    const firstEvents = new SessionEventHub();
    const secondEvents = new SessionEventHub();
    const first = new StreamStatusMachine(firstEvents);
    const second = new StreamStatusMachine(secondEvents);
    const firstPublished = recordSessionEvents(firstEvents, {
      scope: 'session',
    });
    const secondPublished = recordSessionEvents(secondEvents, {
      scope: 'session',
    });
    const streamId = 'stream-status-listener-test' as StreamTabId;

    second.transition(streamId, STREAM_PHASE.WAITING, 'restart-repair');

    expect(sessionFactsOfType(firstPublished.events, 'status')).toEqual([]);
    expect(sessionFactsOfType(secondPublished.events, 'status')).toHaveLength(
      1,
    );
  });

  it('exercises the live machine against the exhaustive transition table', () => {
    for (const from of [undefined, ...phases]) {
      for (const to of phases) {
        for (const cause of causes) {
          const machine = new StreamStatusMachine();
          const streamId =
            `stream-status-table:${from ?? 'none'}:${to}:${cause}` as StreamTabId;
          if (from) seedStreamStatusForTest(machine, streamId, from);

          const accepted = machine.transition(streamId, to, cause);

          expect(accepted, `${from ?? 'undefined'} -> ${to} by ${cause}`).toBe(
            canTransitionStreamPhase(from, to, cause),
          );
          expect(machine.get(streamId)).toBe(accepted ? to : from);
        }
      }
    }
  });

  it('keeps reservations outside the transition table', () => {
    const machine = new StreamStatusMachine();
    const streamId = 'stream-status-reservation-test' as StreamTabId;

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBe(STREAM_SUBSTATE.STARTING);
    expect(machine.getAllStreamStates().get(streamId)).toEqual({
      phase: STREAM_PHASE.RUNNING,
      substate: STREAM_SUBSTATE.STARTING,
    });
    expect(machine.tryAcquire(streamId)).toBe(false);

    machine.releaseIfReserved(streamId);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.transition(streamId, STREAM_PHASE.WAITING, 'wait')).toBe(
      true,
    );
    expect(machine.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(machine.tryAcquire(streamId)).toBe(false);
  });

  it('repairs terminal streams to waiting through resume then wait', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-terminal-waiting-repair',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.CANCELLED);

    expect(machine.transitionToWaiting(streamId, 'restart-repair')).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(statusEvents()).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        previousPhase: STREAM_PHASE.CANCELLED,
        cause: 'resume',
      },
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.WAITING,
        previousPhase: STREAM_PHASE.RUNNING,
        cause: 'restart-repair',
      },
    ]);
  });

  it.each([
    STREAM_TRANSITION_CAUSE.LIFECYCLE,
    STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
  ])('terminalizes waiting streams through resume then %s', (cause) => {
    const { machine, statusEvents, streamId } = setupMachine(
      `stream-status-waiting-terminal-${cause}`,
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.WAITING);

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.FAILED, cause),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(statusEvents()).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        previousPhase: STREAM_PHASE.WAITING,
        cause: 'resume',
      },
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.FAILED,
        previousPhase: STREAM_PHASE.RUNNING,
        cause,
      },
    ]);
  });

  it('terminalizes visible streams that were not started yet', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-undefined-terminal-repair',
    );

    expect(
      machine.transitionToTerminal(
        streamId,
        STREAM_PHASE.FAILED,
        STREAM_TRANSITION_CAUSE.LIFECYCLE,
      ),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(statusEvents()).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
      },
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.FAILED,
        previousPhase: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
      },
    ]);
  });

  it('accepts already-matching terminal outcomes without warning callers', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-matching-terminal',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.CANCELLED);

    expect(
      machine.transitionToTerminal(
        streamId,
        STREAM_PHASE.CANCELLED,
        STREAM_TRANSITION_CAUSE.LIFECYCLE,
      ),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(statusEvents()).toEqual([]);
  });

  it('clears a transient running substate through the table-checked resume transition', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-clear-running-substate',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_STATUS.RESUMING);

    expect(machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume')).toBe(
      true,
    );

    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBeUndefined();
    expect(statusEvents()).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        previousPhase: STREAM_PHASE.RUNNING,
        cause: 'resume',
      },
    ]);
  });

  it('skips the write and publish for a no-op RUNNING resume with no substate to clear', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-noop-running-resume',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.RUNNING);

    expect(machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume')).toBe(
      true,
    );

    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBeUndefined();
    expect(statusEvents()).toEqual([]);
  });

  it('rolls back reservation state identically with and without a hub', () => {
    const hidden = new StreamStatusMachine();
    const events = new SessionEventHub();
    const observed = new StreamStatusMachine(events);
    const published = recordSessionEvents(events, { scope: 'session' });
    const streamId =
      'stream-status-observer-independent-rollback' as StreamTabId;

    expect(hidden.tryAcquire(streamId)).toBe(true);
    expect(observed.tryAcquire(streamId)).toBe(true);

    hidden.releaseIfReserved(streamId);
    observed.releaseIfReserved(streamId);

    expect(hidden.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(observed.get(streamId)).toBe(hidden.get(streamId));
    expect(
      sessionFactsOfType(published.events, 'status').map(
        (event) => event.phase,
      ),
    ).toEqual([STREAM_PHASE.RUNNING, STREAM_PHASE.CANCELLED]);
  });

  it('publishes rollback when a visible reservation is released', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-reservation-rollback',
    );

    expect(machine.tryAcquire(streamId)).toBe(true);
    machine.releaseIfReserved(streamId);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(statusEvents()).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
        substate: STREAM_SUBSTATE.STARTING,
      },
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.CANCELLED,
        previousPhase: STREAM_PHASE.RUNNING,
        cause: 'reservation-rollback',
      },
    ]);
  });

  it('overlays reservations on stale terminal phases and restores them on rollback', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-reservation-overlay',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.COMPLETED);

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle'),
    ).toBe(true);

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.COMPLETED);
    expect(machine.tryAcquire(streamId)).toBe(true);
    machine.releaseIfReserved(streamId);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    expect(statusEvents().at(-1)).toEqual({
      streamId,
      type: 'status',
      phase: STREAM_PHASE.COMPLETED,
      previousPhase: STREAM_PHASE.RUNNING,
      cause: 'reservation-rollback',
    });
  });

  it('bridges canonical status facts to a supplied run trace', () => {
    const events = new SessionEventHub();
    const machine = new StreamStatusMachine(events);
    const publishedRunEvents = recordSessionEvents(events, { scope: 'run' });
    const publishedSessionEvents = recordSessionEvents(events, {
      scope: 'session',
    });
    const trace = new TraceEmitter();
    const streamId = 'stream-status-projection-test' as StreamTabId;
    const statusEvents: StatusEvent[] = [];

    trace.subscribe((event) => {
      if (event.type !== 'status') return;
      statusEvents.push(event);
      events.emit({ scope: 'run', streamId, event });
    });

    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle', {
        trace,
      }),
    ).toBe(true);

    expect(statusEvents[0]).toMatchObject({
      type: 'status',
      streamId,
      phase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
    });
    expect(runEventsOfType(publishedRunEvents.events, 'status')).toEqual([
      statusEvents[0],
    ]);
    expect(sessionFactsOfType(publishedSessionEvents.events, 'status')).toEqual(
      statusEvents,
    );
  });

  it('settles trace subscribers before publishing to session subscribers', () => {
    const events = new SessionEventHub();
    const machine = new StreamStatusMachine(events);
    const trace = new TraceEmitter();
    const streamId = 'stream-status-order-test' as StreamTabId;
    const order: string[] = [];

    trace.subscribe((event) => {
      if (event.type === 'status') order.push('trace');
    });
    events.subscribeStatus(() => order.push('session'));

    machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle', { trace });

    expect(order).toEqual(['trace', 'session']);
  });

  // One rail: the session fact is published by the machine itself, so a
  // trace-owned transition (run start, terminal, manual-retry wait, restart
  // repair) reaches every projector without the caller passing a hub.
  it('publishes the session fact when a trace bridge is present', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-single-rail',
    );
    const trace = new TraceEmitter();

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.WAITING);

    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
        trace,
        substate: STREAM_SUBSTATE.RESUMING,
      }),
    ).toBe(true);

    const payloads = statusEvents();

    // The hub and transcript bridge share the canonical status vocabulary;
    // the public CLI adapter alone performs the frozen wire rename.
    expect(payloads).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        previousPhase: STREAM_PHASE.WAITING,
        cause: 'resume',
        substate: STREAM_SUBSTATE.RESUMING,
      },
    ]);
    expect(Object.keys(payloads[0] ?? {}).toSorted()).toEqual([
      'cause',
      'phase',
      'previousPhase',
      'streamId',
      'substate',
      'type',
    ]);
  });
});
