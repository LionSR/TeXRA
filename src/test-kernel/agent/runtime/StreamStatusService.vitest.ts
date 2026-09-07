import { describe, expect, it, vi } from 'vitest';

import type { StatusEvent } from '@agent/trace';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  STREAM_PHASE,
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

/** Fresh registry + recording host, keyed to a per-test stream id. */
function setupMachine(streamId: string): {
  machine: StreamStatusMachine;
  statusEvents: () => StatusEvent[];
  streamId: StreamTabId;
} {
  const published: StatusEvent[] = [];
  return {
    machine: new StreamStatusMachine(
      (event) => published.push(event),
      () => {},
    ),
    statusEvents: () => published,
    streamId: streamId as StreamTabId,
  };
}

describe('StreamStatusMachine', () => {
  it('keeps stream status state per instance', () => {
    const first = new StreamStatusMachine(
      () => {},
      () => {},
    );
    const second = new StreamStatusMachine(
      () => {},
      () => {},
    );
    const streamId = 'stream-status-instance-test' as StreamTabId;

    seedStreamStatusForTest(first, streamId, { phase: STREAM_PHASE.WAITING });

    expect(first.get(streamId)).toBe(STREAM_PHASE.WAITING);
    expect(second.get(streamId)).toBeUndefined();
  });

  it('publishes only through its owning session hub', () => {
    const firstPublished = { events: [] as StatusEvent[] };
    const secondPublished = { events: [] as StatusEvent[] };
    const first = new StreamStatusMachine(
      (event) => firstPublished.events.push(event),
      () => {},
    );
    const second = new StreamStatusMachine(
      (event) => secondPublished.events.push(event),
      () => {},
    );
    const streamId = 'stream-status-listener-test' as StreamTabId;

    second.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');

    expect(firstPublished.events).toEqual([]);
    expect(secondPublished.events).toHaveLength(1);
  });

  it('exercises the live machine against the exhaustive transition table', () => {
    const phases = Object.values(STREAM_PHASE) as StreamPhase[];
    const causes = Object.values(
      STREAM_TRANSITION_CAUSE,
    ) as StreamTransitionCause[];
    for (const from of [undefined, ...phases]) {
      for (const to of phases) {
        for (const cause of causes) {
          const machine = new StreamStatusMachine(
            () => {},
            () => {},
          );
          const streamId =
            `stream-status-table:${from ?? 'none'}:${to}:${cause}` as StreamTabId;
          if (from) seedStreamStatusForTest(machine, streamId, { phase: from });

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
    const machine = new StreamStatusMachine(
      () => {},
      () => {},
    );
    const streamId = 'stream-status-reservation-test' as StreamTabId;

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBe(STREAM_SUBSTATE.STARTING);
    expect(machine.getAllStreamStates().get(streamId)).toEqual({
      phase: STREAM_PHASE.RUNNING,
      substate: STREAM_SUBSTATE.STARTING,
      runStartedAt: expect.any(Number),
    });
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

  it('refuses to overwrite a live reservation with a hold', () => {
    const { machine, streamId } = setupMachine(
      'stream-status-reservation-vs-hold',
    );

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.markUnavailable(streamId, 'lease lock unavailable')).toBe(
      false,
    );
    expect(machine.holdState(streamId)).toBeUndefined();

    // The rollback the reservation owns still runs.
    machine.releaseIfReserved(streamId);
    expect(machine.get(streamId)).toBeUndefined();
  });

  it('closes the active window in WAITING and restamps after the resume gap', () => {
    vi.useFakeTimers({ now: 1_000 });
    const { machine, streamId } = setupMachine(
      'stream-status-active-window-resume',
    );

    try {
      expect(
        machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle'),
      ).toBe(true);
      expect(machine.getStreamState(streamId)?.runStartedAt).toBe(1_000);

      vi.setSystemTime(5_000);
      expect(machine.transition(streamId, STREAM_PHASE.WAITING, 'wait')).toBe(
        true,
      );
      expect(machine.getStreamState(streamId)).toEqual({
        phase: STREAM_PHASE.WAITING,
      });

      vi.setSystemTime(15_000);
      expect(machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume')).toBe(
        true,
      );
      expect(machine.getStreamState(streamId)?.runStartedAt).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminalizes waiting streams through resume then lifecycle', () => {
    const cause = STREAM_TRANSITION_CAUSE.LIFECYCLE;
    const { machine, statusEvents, streamId } = setupMachine(
      `stream-status-waiting-terminal-${cause}`,
    );

    seedStreamStatusForTest(machine, streamId, { phase: STREAM_PHASE.WAITING });

    expect(
      machine.transitionToTerminal(streamId, STREAM_PHASE.CANCELLED, cause),
    ).toBe(true);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    expect(statusEvents()).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        previousPhase: STREAM_PHASE.WAITING,
        cause: 'resume',
        runStartedAt: expect.any(Number),
      },
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.CANCELLED,
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
        runStartedAt: expect.any(Number),
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

    seedStreamStatusForTest(machine, streamId, {
      phase: STREAM_PHASE.CANCELLED,
    });

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

    seedStreamStatusForTest(machine, streamId, {
      phase: STREAM_PHASE.RUNNING,
      substate: STREAM_SUBSTATE.RESUMING,
    });

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
        runStartedAt: expect.any(Number),
      },
    ]);
  });

  it('skips the write and publish for a no-op RUNNING resume with no substate to clear', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-noop-running-resume',
    );

    seedStreamStatusForTest(machine, streamId, { phase: STREAM_PHASE.RUNNING });

    expect(machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume')).toBe(
      true,
    );

    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(machine.getSubstate(streamId)).toBeUndefined();
    expect(statusEvents()).toEqual([]);
  });

  it('rolls back reservation state identically with and without a subscriber', () => {
    const hidden = new StreamStatusMachine(
      () => {},
      () => {},
    );
    const published = { events: [] as StatusEvent[] };
    const observed = new StreamStatusMachine(
      (event) => published.events.push(event),
      () => {},
    );
    const streamId =
      'stream-status-observer-independent-rollback' as StreamTabId;

    expect(hidden.tryAcquire(streamId)).toBe(true);
    expect(observed.tryAcquire(streamId)).toBe(true);

    hidden.releaseIfReserved(streamId);
    observed.releaseIfReserved(streamId);

    expect(hidden.get(streamId)).toBeUndefined();
    expect(observed.get(streamId)).toBe(hidden.get(streamId));
    expect(published.events).toEqual([]);
  });

  it('overlays reservations on stale terminal phases and restores them on rollback', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-reservation-overlay',
    );

    seedStreamStatusForTest(machine, streamId, {
      phase: STREAM_PHASE.COMPLETED,
    });

    expect(machine.tryAcquire(streamId)).toBe(true);
    expect(machine.get(streamId)).toBe(STREAM_PHASE.RUNNING);
    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'lifecycle'),
    ).toBe(true);

    seedStreamStatusForTest(machine, streamId, {
      phase: STREAM_PHASE.COMPLETED,
    });
    const beforeReservation = statusEvents();
    expect(machine.tryAcquire(streamId)).toBe(true);
    machine.releaseIfReserved(streamId);

    expect(machine.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    expect(statusEvents()).toEqual(beforeReservation);
  });

  // One rail: the session fact is published by the machine itself, so a
  // status transition (run start, terminal, manual-retry wait, restart
  // repair) reaches every projector — including the transcript recorder,
  // which subscribes the same rail via its handleStatus port — without the
  // caller routing anything.
  it('publishes the canonical session fact on the single status rail', () => {
    const { machine, statusEvents, streamId } = setupMachine(
      'stream-status-single-rail',
    );

    seedStreamStatusForTest(machine, streamId, { phase: STREAM_PHASE.WAITING });

    expect(
      machine.transition(streamId, STREAM_PHASE.RUNNING, 'resume', {
        substate: STREAM_SUBSTATE.RESUMING,
      }),
    ).toBe(true);

    const payloads = statusEvents();

    // Every consumer shares the canonical status vocabulary; the public CLI
    // adapter alone performs the frozen wire rename.
    expect(payloads).toEqual([
      {
        streamId,
        type: 'status',
        phase: STREAM_PHASE.RUNNING,
        previousPhase: STREAM_PHASE.WAITING,
        cause: 'resume',
        substate: STREAM_SUBSTATE.RESUMING,
        runStartedAt: expect.any(Number),
      },
    ]);
    expect(Object.keys(payloads[0] ?? {}).toSorted()).toEqual([
      'cause',
      'phase',
      'previousPhase',
      'runStartedAt',
      'streamId',
      'substate',
      'type',
    ]);
  });
});
