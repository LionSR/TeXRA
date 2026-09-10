import { describe, expect, it, vi } from 'vitest';

import type { StatusEvent } from '@agent/trace';
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
import {
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunPhase,
  type RunId,
} from '@shared/schemas';
import {
  canTransitionRunPhase,
  RUN_TRANSITION_CAUSE,
  type RunTransitionCause,
} from '@shared/runs/runStatus';
import { seedRunStatusForTest } from '@test/support/runStatusTestUtils';

/** Fresh registry + recording host, keyed to a per-test stream id. */
function setupMachine(runId: string): {
  machine: RunStatusMachine;
  statusEvents: () => StatusEvent[];
  runId: RunId;
} {
  const published: StatusEvent[] = [];
  return {
    machine: new RunStatusMachine(
      (event) => published.push(event),
      () => {},
    ),
    statusEvents: () => published,
    runId: runId as RunId,
  };
}

describe('RunStatusMachine', () => {
  it('keeps stream status state per instance', () => {
    const first = new RunStatusMachine(
      () => {},
      () => {},
    );
    const second = new RunStatusMachine(
      () => {},
      () => {},
    );
    const runId = 'stream-status-instance-test' as RunId;

    seedRunStatusForTest(first, runId, { phase: RUN_PHASE.WAITING });

    expect(first.get(runId)).toBe(RUN_PHASE.WAITING);
    expect(second.get(runId)).toBeUndefined();
  });

  it('publishes only through its owning session hub', () => {
    const firstPublished = { events: [] as StatusEvent[] };
    const secondPublished = { events: [] as StatusEvent[] };
    const first = new RunStatusMachine(
      (event) => firstPublished.events.push(event),
      () => {},
    );
    const second = new RunStatusMachine(
      (event) => secondPublished.events.push(event),
      () => {},
    );
    const runId = 'stream-status-listener-test' as RunId;

    second.transition(runId, RUN_PHASE.CANCELLED, 'user-stop');

    expect(firstPublished.events).toEqual([]);
    expect(secondPublished.events).toHaveLength(1);
  });

  it('exercises the live machine against the exhaustive transition table', () => {
    const phases = Object.values(RUN_PHASE) as RunPhase[];
    const causes = Object.values(RUN_TRANSITION_CAUSE) as RunTransitionCause[];
    for (const from of [undefined, ...phases]) {
      for (const to of phases) {
        for (const cause of causes) {
          const machine = new RunStatusMachine(
            () => {},
            () => {},
          );
          const runId =
            `stream-status-table:${from ?? 'none'}:${to}:${cause}` as RunId;
          if (from) seedRunStatusForTest(machine, runId, { phase: from });

          const accepted = machine.transition(runId, to, cause);

          expect(accepted, `${from ?? 'undefined'} -> ${to} by ${cause}`).toBe(
            canTransitionRunPhase(from, to, cause),
          );
          expect(machine.get(runId)).toBe(accepted ? to : from);
        }
      }
    }
  });

  it('closes the active window in WAITING and restamps after the resume gap', () => {
    vi.useFakeTimers({ now: 1_000 });
    const { machine, runId } = setupMachine(
      'stream-status-active-window-resume',
    );

    try {
      expect(machine.transition(runId, RUN_PHASE.RUNNING, 'lifecycle')).toBe(
        true,
      );
      expect(machine.getStreamState(runId)?.runStartedAt).toBe(1_000);

      vi.setSystemTime(5_000);
      expect(machine.transition(runId, RUN_PHASE.WAITING, 'wait')).toBe(true);
      expect(machine.getStreamState(runId)).toEqual({
        phase: RUN_PHASE.WAITING,
      });

      vi.setSystemTime(15_000);
      expect(machine.transition(runId, RUN_PHASE.RUNNING, 'resume')).toBe(true);
      expect(machine.getStreamState(runId)?.runStartedAt).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminalizes waiting runs through resume then lifecycle', () => {
    const cause = RUN_TRANSITION_CAUSE.LIFECYCLE;
    const { machine, statusEvents, runId } = setupMachine(
      `stream-status-waiting-terminal-${cause}`,
    );

    seedRunStatusForTest(machine, runId, { phase: RUN_PHASE.WAITING });

    expect(
      machine.transitionToTerminal(runId, RUN_PHASE.CANCELLED, cause),
    ).toBe(true);

    expect(machine.get(runId)).toBe(RUN_PHASE.CANCELLED);
    expect(statusEvents()).toEqual([
      {
        runId,
        type: 'status',
        phase: RUN_PHASE.RUNNING,
        previousPhase: RUN_PHASE.WAITING,
        cause: 'resume',
        runStartedAt: expect.any(Number),
      },
      {
        runId,
        type: 'status',
        phase: RUN_PHASE.CANCELLED,
        previousPhase: RUN_PHASE.RUNNING,
        cause,
      },
    ]);
  });

  it('terminalizes visible runs that were not started yet', () => {
    const { machine, statusEvents, runId } = setupMachine(
      'stream-status-undefined-terminal-repair',
    );

    expect(
      machine.transitionToTerminal(
        runId,
        RUN_PHASE.FAILED,
        RUN_TRANSITION_CAUSE.LIFECYCLE,
      ),
    ).toBe(true);

    expect(machine.get(runId)).toBe(RUN_PHASE.FAILED);
    expect(statusEvents()).toEqual([
      {
        runId,
        type: 'status',
        phase: RUN_PHASE.RUNNING,
        cause: 'lifecycle',
        runStartedAt: expect.any(Number),
      },
      {
        runId,
        type: 'status',
        phase: RUN_PHASE.FAILED,
        previousPhase: RUN_PHASE.RUNNING,
        cause: 'lifecycle',
      },
    ]);
  });

  it('accepts already-matching terminal outcomes without warning callers', () => {
    const { machine, statusEvents, runId } = setupMachine(
      'stream-status-matching-terminal',
    );

    seedRunStatusForTest(machine, runId, {
      phase: RUN_PHASE.CANCELLED,
    });

    expect(
      machine.transitionToTerminal(
        runId,
        RUN_PHASE.CANCELLED,
        RUN_TRANSITION_CAUSE.LIFECYCLE,
      ),
    ).toBe(true);

    expect(machine.get(runId)).toBe(RUN_PHASE.CANCELLED);
    expect(statusEvents()).toEqual([]);
  });

  it('clears a transient running substate through the table-checked resume transition', () => {
    const { machine, statusEvents, runId } = setupMachine(
      'stream-status-clear-running-substate',
    );

    seedRunStatusForTest(machine, runId, {
      phase: RUN_PHASE.RUNNING,
      substate: RUN_SUBSTATE.RESUMING,
    });

    expect(machine.transition(runId, RUN_PHASE.RUNNING, 'resume')).toBe(true);

    expect(machine.get(runId)).toBe(RUN_PHASE.RUNNING);
    expect(machine.getSubstate(runId)).toBeUndefined();
    expect(statusEvents()).toEqual([
      {
        runId,
        type: 'status',
        phase: RUN_PHASE.RUNNING,
        previousPhase: RUN_PHASE.RUNNING,
        cause: 'resume',
        runStartedAt: expect.any(Number),
      },
    ]);
  });

  it('skips the write and publish for a no-op RUNNING resume with no substate to clear', () => {
    const { machine, statusEvents, runId } = setupMachine(
      'stream-status-noop-running-resume',
    );

    seedRunStatusForTest(machine, runId, { phase: RUN_PHASE.RUNNING });

    expect(machine.transition(runId, RUN_PHASE.RUNNING, 'resume')).toBe(true);

    expect(machine.get(runId)).toBe(RUN_PHASE.RUNNING);
    expect(machine.getSubstate(runId)).toBeUndefined();
    expect(statusEvents()).toEqual([]);
  });

  // One rail: the session fact is published by the machine itself, so a
  // status transition (run start, terminal, manual-retry wait, restart
  // repair) reaches every projector — including the transcript recorder,
  // which subscribes the same rail via its handleStatus port — without the
  // caller routing anything.
  it('publishes the canonical session fact on the single status rail', () => {
    const { machine, statusEvents, runId } = setupMachine(
      'stream-status-single-rail',
    );

    seedRunStatusForTest(machine, runId, { phase: RUN_PHASE.WAITING });

    expect(
      machine.transition(runId, RUN_PHASE.RUNNING, 'resume', {
        substate: RUN_SUBSTATE.RESUMING,
      }),
    ).toBe(true);

    const payloads = statusEvents();

    // Every consumer shares the canonical status vocabulary; the public CLI
    // adapter alone performs the frozen wire rename.
    expect(payloads).toEqual([
      {
        runId,
        type: 'status',
        phase: RUN_PHASE.RUNNING,
        previousPhase: RUN_PHASE.WAITING,
        cause: 'resume',
        substate: RUN_SUBSTATE.RESUMING,
        runStartedAt: expect.any(Number),
      },
    ]);
    expect(Object.keys(payloads[0] ?? {}).toSorted()).toEqual([
      'cause',
      'phase',
      'previousPhase',
      'runStartedAt',
      'runId',
      'substate',
      'type',
    ]);
  });
});
