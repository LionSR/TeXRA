// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { seedStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import { TraceEmitter, type StatusEvent } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  StreamStatusMachine,
  type StreamStatusChange,
} from '@agent/runtime/StreamStatusService';
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

import {
  recordSessionEvents,
  runEventsOfType,
  sessionFactPayloads,
} from '../progressTestUtils';

/** Fresh registry + recording host, keyed to a per-test stream id. */
function setupMachine(streamId: string): {
  machine: StreamStatusMachine;
  events: SessionEventHub;
  published: ReturnType<typeof recordSessionEvents>;
  streamId: StreamTabId;
} {
  const events = new SessionEventHub();
  const published = recordSessionEvents(events, { scope: 'session' });
  return {
    machine: new StreamStatusMachine(),
    events,
    published,
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

    seedStreamStatusForTest(first, streamId, STREAM_STATUS.WAITING);

    expect(first.get(streamId)).toBe(STREAM_STATUS.WAITING);
    expect(second.get(streamId)).toBeUndefined();
  });

  it('keeps listeners per instance', () => {
    const first = new StreamStatusMachine();
    const second = new StreamStatusMachine();
    const events = new SessionEventHub();
    const published = recordSessionEvents(events, { scope: 'session' });
    const streamId = 'stream-status-listener-test' as StreamTabId;
    const changes: string[] = [];

    first.onDidChange((change) => changes.push(change.streamId));
    second.transition(streamId, STREAM_PHASE.WAITING, 'restart-repair', {
      events,
    });

    expect(changes).toEqual([]);
    expect(
      sessionFactPayloads(published.events, 'updateStreamStatus'),
    ).toHaveLength(1);
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
    expect(machine.getAllSubstates().get(streamId)).toBe(
      STREAM_SUBSTATE.STARTING,
    );
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
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-terminal-waiting-repair',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.CANCELLED);

    expect(
      machine.transitionToWaiting(streamId, 'restart-repair', {
        events,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [
        {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.CANCELLED,
          cause: 'resume',
        },
        {
          streamId,
          status: STREAM_PHASE.WAITING,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'restart-repair',
        },
      ],
    );
  });

  it('terminalizes waiting streams through resume then lifecycle', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-waiting-terminal-repair',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.WAITING);

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.FAILED, {
        events,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [
        {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.WAITING,
          cause: 'resume',
        },
        {
          streamId,
          status: STREAM_PHASE.FAILED,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      ],
    );
  });

  it('terminalizes visible streams that were not started yet', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-undefined-terminal-repair',
    );

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.FAILED, {
        events,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [
        {
          streamId,
          status: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
        {
          streamId,
          status: STREAM_PHASE.FAILED,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      ],
    );
  });

  it('accepts already-matching terminal outcomes without warning callers', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-matching-terminal',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.CANCELLED);

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.CANCELLED, {
        events,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [],
    );
  });

  it('clears a transient running substate through the table-checked resume transition', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-clear-running-substate',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_STATUS.RESUMING);

    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
        events,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBeUndefined();
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [
        {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'resume',
        },
      ],
    );
  });

  it('skips the write and publish for a no-op RUNNING resume with no substate to clear', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-noop-running-resume',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.RUNNING);

    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
        events,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBeUndefined();
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [],
    );
  });

  it('rolls back reservation state identically with and without observers', () => {
    const hidden = new StreamStatusMachine();
    const observed = new StreamStatusMachine();
    const streamId =
      'stream-status-observer-independent-rollback' as StreamTabId;
    const changes: StreamStatusChange[] = [];

    observed.onDidChange((change) => changes.push(change));

    expect(hidden.tryAcquire(streamId)).toBe(true);
    expect(observed.tryAcquire(streamId)).toBe(true);

    hidden.releaseIfReserved(streamId);
    observed.releaseIfReserved(streamId);

    expect(hidden.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(observed.get(streamId)).toBe(hidden.get(streamId));
    expect(changes.map((change) => change.status)).toEqual([
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.CANCELLED,
    ]);
  });

  it('publishes rollback when a visible reservation is released', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-reservation-rollback',
    );

    expect(machine.tryAcquire(streamId, { events })).toBe(true);
    machine.releaseIfReserved(streamId, { events });

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(sessionFactPayloads(published.events, 'updateStreamStatus')).toEqual(
      [
        {
          streamId,
          status: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
          substate: STREAM_SUBSTATE.STARTING,
        },
        {
          streamId,
          status: STREAM_PHASE.CANCELLED,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      ],
    );
  });

  it('overlays reservations on stale terminal phases and restores them on rollback', () => {
    const { machine, events, published, streamId } = setupMachine(
      'stream-status-reservation-overlay',
    );

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.COMPLETED);

    expect(machine.tryAcquire(streamId, { events })).toBe(true);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle'),
    ).toBe(true);

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.COMPLETED);
    expect(machine.tryAcquire(streamId, { events })).toBe(true);
    machine.releaseIfReserved(streamId, { events });

    expect(machine.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    expect(
      sessionFactPayloads(published.events, 'updateStreamStatus').at(-1),
    ).toEqual({
      streamId,
      status: STREAM_PHASE.COMPLETED,
      previousStatus: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
    });
  });

  it('emits status trace events when a trace owns publication', () => {
    const machine = new StreamStatusMachine();
    const events = new SessionEventHub();
    const published = recordSessionEvents(events, { scope: 'run' });
    const trace = new TraceEmitter();
    const streamId = 'stream-status-projection-test' as StreamTabId;
    const statusEvents: StatusEvent[] = [];
    const changes: StreamStatusChange[] = [];

    trace.subscribe((event) => {
      if (event.type !== 'status') return;
      statusEvents.push(event);
      events.emit({ scope: 'run', streamId, event });
    });
    machine.onDidChange((change) => changes.push(change));

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
    expect(runEventsOfType(published.events, 'status')).toEqual([
      statusEvents[0],
    ]);
    expect(changes).toEqual([
      {
        streamId,
        status: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
      },
    ]);
  });
});
