// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  StreamPhaseSchema,
  type RunOutcome,
  type StreamPhase,
} from '@shared/schemas';
import {
  canAcquireStreamReservation,
  canTransitionStreamPhase,
  deriveRunOutcome,
  isActivePhase,
  isInFlightPhase,
  isTerminalOutcomePhase,
  legacyEndGroupStatusForOutcome,
  projectRunOutcome,
  RUN_OUTCOME_PROJECTION,
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';

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
  // canonical value down to a legacy bucket). Its single remaining caller is
  // the frozen CLI headless JSON's `endGroupStatus` projection
  // (packages/cli/src/runtime/terminalStatus.ts), whose own removal is dated
  // in the #6981 ledger — the fold itself is unchanged, so it still needs to
  // stay correct until then. The intermediate `groupEndStatusForOutcome`
  // ('ok' | 'error') hop was deleted with the rest of the legacy vocabulary
  // production surface (#7993 step 4): it had no caller but this one.
  it('folds each outcome into the frozen 2-value legacy projection', () => {
    expect(legacyEndGroupStatusForOutcome(RUN_OUTCOME.COMPLETED)).toBe(
      'stopped',
    );
    expect(legacyEndGroupStatusForOutcome(RUN_OUTCOME.CANCELLED)).toBe(
      'stopped',
    );
    expect(legacyEndGroupStatusForOutcome(RUN_OUTCOME.FAILED)).toBe('error');
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

// The membership sets these three predicates answer used to be derived from
// the legacy 7-value STREAM_STATUS_TRAITS table, deleted with the rest of the
// legacy vocabulary's production surface (#7993 step 4). They are now the only
// enumeration of "which phases are active / in flight / terminal", so pin them
// exhaustively over the phase vocabulary rather than by example.
describe('stream phase membership predicates', () => {
  const membership: Record<
    StreamPhase,
    { active: boolean; inFlight: boolean; terminalOutcome: boolean }
  > = {
    [STREAM_PHASE.RUNNING]: {
      active: true,
      inFlight: true,
      terminalOutcome: false,
    },
    // WAITING is the deliberate oddball the old trait table also made
    // visible: the cycle ended, but a follow-up appends to the same stream,
    // so it is not acquirable and not a terminal outcome either.
    [STREAM_PHASE.WAITING]: {
      active: false,
      inFlight: true,
      terminalOutcome: false,
    },
    [STREAM_PHASE.COMPLETED]: {
      active: false,
      inFlight: false,
      terminalOutcome: true,
    },
    [STREAM_PHASE.CANCELLED]: {
      active: false,
      inFlight: false,
      terminalOutcome: true,
    },
    [STREAM_PHASE.FAILED]: {
      active: false,
      inFlight: false,
      terminalOutcome: true,
    },
  };

  it('classifies every phase, and treats absence as no-run-yet', () => {
    for (const phase of StreamPhaseSchema.options) {
      expect(isActivePhase(phase)).toBe(membership[phase].active);
      expect(isInFlightPhase(phase)).toBe(membership[phase].inFlight);
      expect(isTerminalOutcomePhase(phase)).toBe(
        membership[phase].terminalOutcome,
      );
    }

    expect(isActivePhase(undefined)).toBe(false);
    expect(isInFlightPhase(undefined)).toBe(false);
    expect(isTerminalOutcomePhase(undefined)).toBe(false);
  });

  it('makes every terminal outcome phase a RunOutcome', () => {
    const terminalPhases = StreamPhaseSchema.options.filter(
      isTerminalOutcomePhase,
    );
    expect(new Set<string>(terminalPhases)).toEqual(
      new Set<string>(Object.values(RUN_OUTCOME)),
    );
  });
});
