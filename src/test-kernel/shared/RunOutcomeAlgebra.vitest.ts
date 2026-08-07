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
  projectRunOutcome,
  RUN_OUTCOME_PROJECTION,
  STREAM_TRANSITION_CAUSE,
  type StreamTransitionCause,
} from '@shared/streams/streamStatus';

describe('run outcome algebra', () => {
  it.each([
    {
      flags: { failed: false, cancelled: false },
      expected: RUN_OUTCOME.COMPLETED,
    },
    {
      flags: { failed: false, cancelled: true },
      expected: RUN_OUTCOME.CANCELLED,
    },
    { flags: { failed: true, cancelled: false }, expected: RUN_OUTCOME.FAILED },
    // Failure wins over a concurrent interrupt — a run that failed and was
    // then stopped is still a failure.
    { flags: { failed: true, cancelled: true }, expected: RUN_OUTCOME.FAILED },
  ])(
    'derives outcomes with failed > cancelled > completed priority ($flags)',
    ({ flags, expected }) => {
      expect(deriveRunOutcome(flags)).toBe(expected);
    },
  );

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

  type CauseRow = Record<StreamTransitionCause, readonly StreamPhase[]>;

  const NO_TRANSITIONS = Object.fromEntries(
    causes.map((cause): [StreamTransitionCause, readonly StreamPhase[]] => [
      cause,
      [],
    ]),
  ) as CauseRow;
  const RESUME_ONLY: CauseRow = {
    ...NO_TRANSITIONS,
    [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
  };

  const allowed: Record<StreamPhase, CauseRow> = {
    [STREAM_PHASE.RUNNING]: {
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [
        STREAM_PHASE.COMPLETED,
        STREAM_PHASE.CANCELLED,
        STREAM_PHASE.FAILED,
      ],
      [STREAM_TRANSITION_CAUSE.RESERVATION_ROLLBACK]: [
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
      ...NO_TRANSITIONS,
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [STREAM_PHASE.CANCELLED],
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: [STREAM_PHASE.WAITING],
    },
    [STREAM_PHASE.COMPLETED]: RESUME_ONLY,
    [STREAM_PHASE.CANCELLED]: RESUME_ONLY,
    [STREAM_PHASE.FAILED]: RESUME_ONLY,
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
    const fromIdle: CauseRow = {
      ...NO_TRANSITIONS,
      [STREAM_TRANSITION_CAUSE.LIFECYCLE]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.RESUME]: [STREAM_PHASE.RUNNING],
      [STREAM_TRANSITION_CAUSE.USER_STOP]: [STREAM_PHASE.CANCELLED],
      // Restart repair may land on any phase.
      [STREAM_TRANSITION_CAUSE.RESTART_REPAIR]: phases,
    };

    for (const cause of causes) {
      for (const to of phases) {
        expect(canTransitionStreamPhase(undefined, to, cause)).toBe(
          fromIdle[cause].includes(to),
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
