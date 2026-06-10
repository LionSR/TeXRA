// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  deriveRunOutcome,
  isActiveStatus,
  isInFlightStatus,
  isTerminalStatus,
  projectRunOutcome,
  RUN_OUTCOME_PROJECTION,
} from '@common/constants/streamStatus';
import {
  EXECUTION_STATUS,
  LIVE_ELAPSED_STREAM_STATUSES,
  RUN_OUTCOME,
  STREAM_STATUS,
  streamStatusesWithTrait,
  type RunOutcome,
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

  it('projects each outcome into the three legacy vocabularies', () => {
    expect(RUN_OUTCOME_PROJECTION[RUN_OUTCOME.COMPLETED]).toEqual({
      executionStatus: EXECUTION_STATUS.COMPLETED,
      endGroupStatus: 'stopped',
      streamStatus: STREAM_STATUS.STOPPED,
    });
    // A user stop persists 'interrupted' and ends the transcript group
    // neutral — cancelled is a sibling of failed, never folded into it.
    expect(RUN_OUTCOME_PROJECTION[RUN_OUTCOME.CANCELLED]).toEqual({
      executionStatus: EXECUTION_STATUS.INTERRUPTED,
      endGroupStatus: 'stopped',
      streamStatus: STREAM_STATUS.STOPPED,
    });
    expect(RUN_OUTCOME_PROJECTION[RUN_OUTCOME.FAILED]).toEqual({
      executionStatus: EXECUTION_STATUS.ERROR,
      endGroupStatus: 'error',
      streamStatus: STREAM_STATUS.ERROR,
    });
  });

  it('fails loudly on an out-of-vocabulary outcome', () => {
    expect(() => projectRunOutcome('bogus' as RunOutcome)).toThrow(
      'Unhandled run outcome: bogus',
    );
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
  });

  it('treats undefined as no status for every predicate', () => {
    expect(isActiveStatus(undefined)).toBe(false);
    expect(isInFlightStatus(undefined)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});
