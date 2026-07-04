// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { seedStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import { TraceEmitter, type StatusEvent } from '@agent/trace';
import {
  projectStatusEvent,
  StreamStatusRegistry,
} from '@agent/runtime/StreamStatusService';
import {
  canTransitionStreamPhase,
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@common/constants/streamStatus';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('StreamStatusRegistry', () => {
  const phases = Object.values(STREAM_PHASE) as StreamPhase[];
  const causes = Object.values(
    STREAM_TRANSITION_CAUSE,
  ) as StreamTransitionCause[];

  it('keeps stream status state per instance', () => {
    const first = new StreamStatusRegistry();
    const second = new StreamStatusRegistry();
    const streamId = 'stream-status-instance-test' as StreamTabId;

    seedStreamStatusForTest(first, streamId, STREAM_STATUS.WAITING);

    expect(first.get(streamId)).toBe(STREAM_STATUS.WAITING);
    expect(second.get(streamId)).toBeUndefined();
  });

  it('keeps listeners per instance', () => {
    const first = new StreamStatusRegistry();
    const second = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-listener-test' as StreamTabId;
    const changes: string[] = [];

    first.onDidChange((change) => changes.push(change.streamId));
    second.transition(streamId, STREAM_PHASE.WAITING, 'restart-repair', {
      runtimeHost: explicit.host,
    });

    expect(changes).toEqual([]);
    expect(explicit.events.map((entry) => entry.event)).toEqual([
      'updateStreamStatus',
    ]);
  });

  it('exercises the live machine against the exhaustive transition table', () => {
    for (const from of [undefined, ...phases]) {
      for (const to of phases) {
        for (const cause of causes) {
          const machine = new StreamStatusRegistry();
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
    const machine = new StreamStatusRegistry();
    const streamId = 'stream-status-reservation-test' as StreamTabId;

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBe(STREAM_SUBSTATE.STARTING);
    expect(machine.getAllSubstates().get(streamId)).toBe(
      STREAM_SUBSTATE.STARTING,
    );
    expect(machine.tryAcquire(streamId)).toBe(false);

    machine.releaseIfReserved(streamId);
    expect(machine.get(streamId)).toBeUndefined();

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.transition(streamId, STREAM_PHASE.WAITING, 'wait')).toBe(
      true,
    );
    expect(machine.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(machine.tryAcquire(streamId)).toBe(false);
  });

  it('repairs terminal streams to waiting through resume then wait', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-terminal-waiting-repair' as StreamTabId;

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.CANCELLED);

    expect(
      machine.transitionToWaiting(streamId, 'restart-repair', {
        runtimeHost: explicit.host,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(explicit.events).toEqual([
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.CANCELLED,
          cause: 'resume',
        },
      },
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.WAITING,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'restart-repair',
        },
      },
    ]);
  });

  it('terminalizes waiting streams through resume then lifecycle', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-waiting-terminal-repair' as StreamTabId;

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.WAITING);

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.FAILED, {
        runtimeHost: explicit.host,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(explicit.events).toEqual([
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.WAITING,
          cause: 'resume',
        },
      },
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.FAILED,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      },
    ]);
  });

  it('terminalizes visible streams that were not started yet', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-undefined-terminal-repair' as StreamTabId;

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.FAILED, {
        runtimeHost: explicit.host,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.FAILED);
    expect(explicit.events).toEqual([
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      },
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.FAILED,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      },
    ]);
  });

  it('accepts already-matching terminal outcomes without warning callers', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-matching-terminal' as StreamTabId;

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.CANCELLED);

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.CANCELLED, {
        runtimeHost: explicit.host,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(explicit.events).toEqual([]);
  });

  it('clears transient running substates without changing phase', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-clear-running-substate' as StreamTabId;

    seedStreamStatusForTest(machine, streamId, STREAM_STATUS.RESUMING);

    expect(
      machine.clearRunningSubstate(streamId, 'resume', {
        runtimeHost: explicit.host,
      }),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBeUndefined();
    expect(explicit.events).toEqual([
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.RUNNING,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'resume',
        },
      },
    ]);
  });

  it('publishes rollback when a visible reservation is released', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-reservation-rollback' as StreamTabId;

    expect(machine.tryAcquire(streamId, { runtimeHost: explicit.host })).toBe(
      true,
    );
    machine.releaseIfReserved(streamId, { runtimeHost: explicit.host });

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(explicit.events).toEqual([
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
          substate: STREAM_SUBSTATE.STARTING,
        },
      },
      {
        event: 'updateStreamStatus',
        payload: {
          streamId,
          status: STREAM_PHASE.CANCELLED,
          previousStatus: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        },
      },
    ]);
  });

  it('overlays reservations on stale terminal phases and restores them on rollback', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const streamId = 'stream-status-reservation-overlay' as StreamTabId;

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.COMPLETED);

    expect(machine.tryAcquire(streamId, { runtimeHost: explicit.host })).toBe(
      true,
    );
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle'),
    ).toBe(true);

    seedStreamStatusForTest(machine, streamId, STREAM_PHASE.COMPLETED);
    expect(machine.tryAcquire(streamId, { runtimeHost: explicit.host })).toBe(
      true,
    );
    machine.releaseIfReserved(streamId, { runtimeHost: explicit.host });

    expect(machine.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    expect(explicit.events.at(-1)).toEqual({
      event: 'updateStreamStatus',
      payload: {
        streamId,
        status: STREAM_PHASE.COMPLETED,
        previousStatus: STREAM_PHASE.RUNNING,
        cause: 'lifecycle',
      },
    });
  });

  it('projects status trace events to updateStreamStatus payloads', () => {
    const machine = new StreamStatusRegistry();
    const explicit = createRecordingHost();
    const trace = new TraceEmitter();
    const streamId = 'stream-status-projection-test' as StreamTabId;
    const statusEvents: StatusEvent[] = [];
    const changes: ReturnType<typeof projectStatusEvent>[] = [];

    trace.subscribe((event) => {
      if (event.type === 'status') statusEvents.push(event);
    });
    machine.onDidChange((change) => changes.push(change));

    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle', {
        runtimeHost: explicit.host,
        trace,
      }),
    ).toBe(true);

    const projected = projectStatusEvent(statusEvents[0]!);
    expect(statusEvents[0]).toMatchObject({
      type: 'status',
      streamId,
      phase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
    });
    expect(explicit.events).toEqual([
      { event: 'updateStreamStatus', payload: projected },
    ]);
    expect(changes).toEqual([projected]);
  });
});
