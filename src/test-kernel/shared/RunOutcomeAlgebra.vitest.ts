// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  CLI_RUN_STATUS,
  RUN_OUTCOME,
  RUN_PHASE,
  RunPhaseSchema,
  type RunOutcome,
  type RunPhase,
} from '@shared/schemas';
import {
  canTransitionRunPhase,
  deriveRunOutcome,
  isActivePhase,
  isInFlightPhase,
  isTerminalOutcomePhase,
  runOutcomeToCliRunStatus,
  RUN_TRANSITION_CAUSE,
  type RunTransitionCause,
} from '@shared/runs/runStatus';

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

  it('projects each outcome into the injective legacy run vocabulary', () => {
    expect(runOutcomeToCliRunStatus(RUN_OUTCOME.COMPLETED)).toBe(
      CLI_RUN_STATUS.COMPLETED,
    );
    // A user stop persists 'interrupted' and ends the transcript group
    // neutral — cancelled is a sibling of failed, never folded into it.
    expect(runOutcomeToCliRunStatus(RUN_OUTCOME.CANCELLED)).toBe(
      CLI_RUN_STATUS.INTERRUPTED,
    );
    expect(runOutcomeToCliRunStatus(RUN_OUTCOME.FAILED)).toBe(
      CLI_RUN_STATUS.ERROR,
    );
  });

  it('fails loudly on an out-of-vocabulary outcome', () => {
    expect(() => runOutcomeToCliRunStatus('bogus' as RunOutcome)).toThrow(
      'Unhandled run outcome: bogus',
    );
  });
});

describe('stream phase transition table', () => {
  const phases = RunPhaseSchema.options;
  const causes = Object.values(RUN_TRANSITION_CAUSE) as RunTransitionCause[];

  type CauseRow = Record<RunTransitionCause, readonly RunPhase[]>;

  const NO_TRANSITIONS = Object.fromEntries(
    causes.map((cause): [RunTransitionCause, readonly RunPhase[]] => [
      cause,
      [],
    ]),
  ) as CauseRow;
  const RESUME_ONLY: CauseRow = {
    ...NO_TRANSITIONS,
    [RUN_TRANSITION_CAUSE.RESUME]: [RUN_PHASE.RUNNING],
  };

  const allowed: Record<RunPhase, CauseRow> = {
    [RUN_PHASE.RUNNING]: {
      [RUN_TRANSITION_CAUSE.LIFECYCLE]: [
        RUN_PHASE.COMPLETED,
        RUN_PHASE.CANCELLED,
        RUN_PHASE.FAILED,
      ],
      [RUN_TRANSITION_CAUSE.WAIT]: [RUN_PHASE.WAITING],
      [RUN_TRANSITION_CAUSE.RESUME]: [RUN_PHASE.RUNNING],
      [RUN_TRANSITION_CAUSE.USER_STOP]: [RUN_PHASE.CANCELLED],
    },
    [RUN_PHASE.WAITING]: {
      ...NO_TRANSITIONS,
      [RUN_TRANSITION_CAUSE.RESUME]: [RUN_PHASE.RUNNING],
      [RUN_TRANSITION_CAUSE.USER_STOP]: [RUN_PHASE.CANCELLED],
    },
    [RUN_PHASE.COMPLETED]: RESUME_ONLY,
    [RUN_PHASE.CANCELLED]: RESUME_ONLY,
    [RUN_PHASE.FAILED]: RESUME_ONLY,
  };

  it('is exhaustive over every phase, cause, and destination phase', () => {
    for (const from of phases) {
      for (const cause of causes) {
        for (const to of phases) {
          expect(canTransitionRunPhase(from, to, cause)).toBe(
            allowed[from][cause].includes(to),
          );
        }
      }
    }
  });

  it('admits only named start causes from idle', () => {
    const fromIdle: CauseRow = {
      ...NO_TRANSITIONS,
      [RUN_TRANSITION_CAUSE.LIFECYCLE]: [RUN_PHASE.RUNNING],
      [RUN_TRANSITION_CAUSE.RESUME]: [RUN_PHASE.RUNNING],
      [RUN_TRANSITION_CAUSE.USER_STOP]: [RUN_PHASE.CANCELLED],
    };

    for (const cause of causes) {
      for (const to of phases) {
        expect(canTransitionRunPhase(undefined, to, cause)).toBe(
          fromIdle[cause].includes(to),
        );
      }
    }
  });
});

// The membership sets these three predicates answer used to be derived from
// the legacy 7-value STREAM_STATUS_TRAITS table, deleted with the rest of the
// legacy vocabulary's production surface (#7993 step 4). They are now the only
// enumeration of "which phases are active / in flight / terminal", so pin them
// exhaustively over the phase vocabulary rather than by example.
describe('stream phase membership predicates', () => {
  const membership: Record<
    RunPhase,
    { active: boolean; inFlight: boolean; terminalOutcome: boolean }
  > = {
    [RUN_PHASE.RUNNING]: {
      active: true,
      inFlight: true,
      terminalOutcome: false,
    },
    // WAITING is the deliberate oddball the old trait table also made
    // visible: the cycle ended, but a follow-up appends to the same stream,
    // so it is not acquirable and not a terminal outcome either.
    [RUN_PHASE.WAITING]: {
      active: false,
      inFlight: true,
      terminalOutcome: false,
    },
    [RUN_PHASE.COMPLETED]: {
      active: false,
      inFlight: false,
      terminalOutcome: true,
    },
    [RUN_PHASE.CANCELLED]: {
      active: false,
      inFlight: false,
      terminalOutcome: true,
    },
    [RUN_PHASE.FAILED]: {
      active: false,
      inFlight: false,
      terminalOutcome: true,
    },
  };

  it('classifies every phase, and treats absence as no-run-yet', () => {
    for (const phase of RunPhaseSchema.options) {
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
    const terminalPhases = RunPhaseSchema.options.filter(
      isTerminalOutcomePhase,
    );
    expect(new Set<string>(terminalPhases)).toEqual(
      new Set<string>(Object.values(RUN_OUTCOME)),
    );
  });
});
