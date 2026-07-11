// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  canAcquireStreamReservation,
  canTransitionStreamPhase,
  deriveRunOutcome,
  groupEndStatusForOutcome,
  isActiveStatus,
  isInFlightStatus,
  isLiveElapsedStatus,
  isTerminalStatus,
  legacyEndGroupStatusForOutcome,
  projectRunOutcome,
  RUN_OUTCOME_PROJECTION,
  STREAM_TRANSITION_CAUSE,
  terminalStreamStatusForOutcome,
  type StreamTransitionCause,
} from '@common/constants/streamStatus';
import {
  EXECUTION_STATUS,
  LIVE_ELAPSED_STREAM_STATUSES,
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  StreamPhaseSchema,
  streamStatusesWithTrait,
  type RunOutcome,
  type StreamPhase,
} from '@shared/schemas';

describe('run outcome algebra', () => {
  it('derives outcomes with failed > cancelled > completed priority', () => {
    expect(deriveRunOutcome({ failed: false, cancelled: false })).toBe(
      RUN_OUTCOME.COMPLETED,
    );
    expect(deriveRunOutcome({ failed: false, cancelled: true })).toBe(
      RUN_OUTCOME.CANCELLED,
    );
    expect(deriveRunOutcome({ failed: true, cancelled: false })).toBe(
      RUN_OUTCOME.FAILED,
    );
    // Failure wins over a concurrent interrupt — a run that failed and was
    // then stopped is still a failure.
    expect(deriveRunOutcome({ failed: true, cancelled: true })).toBe(
      RUN_OUTCOME.FAILED,
    );
  });

  it('projects each outcome into the injective legacy execution vocabulary', () => {
    expect(RUN_OUTCOME_PROJECTION[RUN_OUTCOME.COMPLETED]).toEqual({
      executionStatus: EXECUTION_STATUS.COMPLETED,
    });
    // A user stop persists 'interrupted' and ends the transcript group
    // neutral — cancelled is a sibling of failed, never folded into it.
    expect(RUN_OUTCOME_PROJECTION[RUN_OUTCOME.CANCELLED]).toEqual({
      executionStatus: EXECUTION_STATUS.INTERRUPTED,
    });
    expect(RUN_OUTCOME_PROJECTION[RUN_OUTCOME.FAILED]).toEqual({
      executionStatus: EXECUTION_STATUS.ERROR,
    });
  });

  // legacyEndGroupStatusForOutcome is no longer called from any production
  // GROUP_END write site (#8087 retypes stage.end()/StreamLogStore's orphan
  // sweep to write the literal RunOutcome), nor from logSlice.ts's read side
  // (#7993 step 3 retypes TaskGroup.status to the native StreamPhase/
  // RunOutcome vocabulary, so that reader no longer needs to fold a
  // canonical value down to a legacy bucket). It survives as a Tier-4-only
  // read-side derive helper for the frozen CLI headless JSON's
  // `endGroupStatus` projection (packages/cli/src/runtime/terminalStatus.ts)
  // — the algebra itself is unchanged, so it still needs to stay correct.
  it('derives folded legacy group-end and stream-status projections from one helper', () => {
    expect(groupEndStatusForOutcome(RUN_OUTCOME.COMPLETED)).toBe('ok');
    expect(groupEndStatusForOutcome(RUN_OUTCOME.CANCELLED)).toBe('ok');
    expect(groupEndStatusForOutcome(RUN_OUTCOME.FAILED)).toBe('error');

    expect(legacyEndGroupStatusForOutcome(RUN_OUTCOME.COMPLETED)).toBe(
      'stopped',
    );
    expect(legacyEndGroupStatusForOutcome(RUN_OUTCOME.CANCELLED)).toBe(
      'stopped',
    );
    expect(legacyEndGroupStatusForOutcome(RUN_OUTCOME.FAILED)).toBe('error');

    expect(terminalStreamStatusForOutcome(RUN_OUTCOME.COMPLETED)).toBe(
      STREAM_STATUS.STOPPED,
    );
    expect(terminalStreamStatusForOutcome(RUN_OUTCOME.CANCELLED)).toBe(
      STREAM_STATUS.STOPPED,
    );
    expect(terminalStreamStatusForOutcome(RUN_OUTCOME.FAILED)).toBe(
      STREAM_STATUS.ERROR,
    );
  });

  it('fails loudly on an out-of-vocabulary outcome', () => {
    expect(() => projectRunOutcome('bogus' as RunOutcome)).toThrow(
      'Unhandled run outcome: bogus',
    );
  });
});

describe('stream phase transition table', () => {
  const phases = StreamPhaseSchema.options;
  const causes = Object.values(
    STREAM_TRANSITION_CAUSE,
  ) as StreamTransitionCause[];

  const allowed: Record<
    StreamPhase,
    Record<StreamTransitionCause, readonly StreamPhase[]>
  > = {
    [STREAM_PHASE.RUNNING]: {
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [
        STREAM_PHASE.COMPLETED,
        STREAM_PHASE.CANCELLED,
        STREAM_PHASE.FAILED,
      ],
      [STREAM_TRANSITION_CAUSE.WAIT]: [STREAM_PHASE.WAITING],
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [STREAM_PHASE.CANCELLED],
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: [
        STREAM_PHASE.RUNNING,
        STREAM_PHASE.WAITING,
        STREAM_PHASE.FAILED,
        STREAM_PHASE.CANCELLED,
      ],
    },
    [STREAM_PHASE.WAITING]: {
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [],
      [STREAM_TRANSITION_CAUSE.WAIT]: [],
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [STREAM_PHASE.CANCELLED],
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: [STREAM_PHASE.WAITING],
    },
    [STREAM_PHASE.COMPLETED]: {
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [],
      [STREAM_TRANSITION_CAUSE.WAIT]: [],
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [],
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: [],
    },
    [STREAM_PHASE.CANCELLED]: {
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [],
      [STREAM_TRANSITION_CAUSE.WAIT]: [],
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [],
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: [],
    },
    [STREAM_PHASE.FAILED]: {
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [],
      [STREAM_TRANSITION_CAUSE.WAIT]: [],
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [],
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: [],
    },
  };

  it('is exhaustive over every phase, cause, and destination phase', () => {
    for (const from of phases) {
      for (const cause of causes) {
        for (const to of phases) {
          expect(canTransitionStreamPhase(from, to, cause)).toBe(
            allowed[from][cause].includes(to),
          );
        }
      }
    }
  });

  it('admits only named start causes from idle', () => {
    for (const cause of causes) {
      for (const to of phases) {
        expect(canTransitionStreamPhase(undefined, to, cause)).toBe(
          (cause === STREAM_TRANSITION_CAUSE.LIFECYCLE &&
            to === STREAM_PHASE.RUNNING) ||
            (cause === STREAM_TRANSITION_CAUSE.RESUME &&
              to === STREAM_PHASE.RUNNING) ||
            (cause === STREAM_TRANSITION_CAUSE.USER_STOP &&
              to === STREAM_PHASE.CANCELLED) ||
            cause === STREAM_TRANSITION_CAUSE.RESTART_REPAIR,
        );
      }
    }
  });

  it('pins reservation invariants separately from transitions', () => {
    expect(canAcquireStreamReservation(undefined)).toBe(true);
    expect(canAcquireStreamReservation(STREAM_PHASE.RUNNING)).toBe(false);
    expect(canAcquireStreamReservation(STREAM_PHASE.WAITING)).toBe(false);
    expect(canAcquireStreamReservation(STREAM_PHASE.COMPLETED)).toBe(true);
    expect(canAcquireStreamReservation(STREAM_PHASE.CANCELLED)).toBe(true);
    expect(canAcquireStreamReservation(STREAM_PHASE.FAILED)).toBe(true);
  });
});

describe('stream status trait table', () => {
  it('derives the historical membership sets from traits', () => {
    expect(streamStatusesWithTrait('active')).toEqual(
      new Set([STREAM_STATUS.RUNNING, STREAM_STATUS.RESUMING]),
    );
    expect(streamStatusesWithTrait('inFlight')).toEqual(
      new Set([
        STREAM_STATUS.RUNNING,
        STREAM_STATUS.RESUMING,
        STREAM_STATUS.INITIALIZING,
        STREAM_STATUS.WAITING,
      ]),
    );
    expect(LIVE_ELAPSED_STREAM_STATUSES).toEqual(
      new Set([
        STREAM_STATUS.RUNNING,
        STREAM_STATUS.RESUMING,
        STREAM_STATUS.INITIALIZING,
      ]),
    );
    expect(streamStatusesWithTrait('terminal')).toEqual(
      new Set([
        STREAM_STATUS.WAITING,
        STREAM_STATUS.STOPPED,
        STREAM_STATUS.ERROR,
        STREAM_STATUS.READY,
      ]),
    );
  });

  it('pins the deliberate oddballs', () => {
    // WAITING is terminal (cycle ended, status bar idle) AND in-flight
    // (follow-up appends to the same log; not acquirable by a new run).
    expect(isTerminalStatus(STREAM_STATUS.WAITING)).toBe(true);
    expect(isInFlightStatus(STREAM_STATUS.WAITING)).toBe(true);
    // INITIALIZING is neither active nor terminal: pre-start, ticking
    // elapsed time, blocking acquisition, running no model calls.
    expect(isActiveStatus(STREAM_STATUS.INITIALIZING)).toBe(false);
    expect(isTerminalStatus(STREAM_STATUS.INITIALIZING)).toBe(false);
    expect(isInFlightStatus(STREAM_STATUS.INITIALIZING)).toBe(true);
    expect(isLiveElapsedStatus(STREAM_STATUS.INITIALIZING)).toBe(true);
  });

  it('treats undefined as no status for every predicate', () => {
    expect(isActiveStatus(undefined)).toBe(false);
    expect(isInFlightStatus(undefined)).toBe(false);
    expect(isLiveElapsedStatus(undefined)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it('treats unknown child execution statuses as not live elapsed', () => {
    expect(isLiveElapsedStatus('completed')).toBe(false);
  });
});
