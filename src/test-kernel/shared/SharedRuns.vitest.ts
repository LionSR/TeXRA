// Suites for src/shared/runs (stream metadata, status display).

import { describe, expect, it } from 'vitest';
import {
  RUN_LIFECYCLE_READY,
  type ActiveChildInfo,
  AgentCategory,
  RUN_PHASE,
  RUN_SUBSTATE,
  type RunLifecycleStatus,
} from '@shared/schemas';
import {
  formatPhaseStageLabel,
  formatRoundStageLabel,
  formatStageLabel,
  formatRunStatusLabel,
  progressHeaderStatus,
} from '@shared/runs/runStatusDisplay';

// ---------------------------------------------------------------------------
// StreamMetadata
// ---------------------------------------------------------------------------

describe('formatPhaseStageLabel', () => {
  it('renders the one-based phase over the declared total', () => {
    expect(formatPhaseStageLabel({ label: 'Reduce', index: 1, total: 3 })).toBe(
      'Reduce (2/3)',
    );
  });

  it('renders the bare position when no total was declared', () => {
    expect(formatPhaseStageLabel({ label: 'Reduce', index: 1 })).toBe(
      'Reduce (2)',
    );
  });

  it('renders only the title for a dynamically opened phase', () => {
    expect(formatPhaseStageLabel({ label: 'Cleanup' })).toBe('Cleanup');
  });

  it('passes undefined through for runs without a phase', () => {
    expect(formatPhaseStageLabel(undefined)).toBeUndefined();
  });
});

describe('formatStageLabel', () => {
  it('labels a round stage through the round formatter', () => {
    expect(formatStageLabel({ kind: 'round', index: 1, total: 3 })).toBe(
      'r2/3',
    );
  });

  it('labels a phase stage through the phase formatter', () => {
    expect(
      formatStageLabel({ kind: 'phase', label: 'Reduce', index: 1, total: 3 }),
    ).toBe('Reduce (2/3)');
  });

  it('passes undefined through for a stream with no stage open', () => {
    expect(formatStageLabel(undefined)).toBeUndefined();
  });
});

describe('stream status display labels', () => {
  const wordingCases: Array<[RunLifecycleStatus, string]> = [
    [RUN_PHASE.WAITING, 'Idle'],
    [RUN_PHASE.COMPLETED, 'Completed'],
    [RUN_PHASE.CANCELLED, 'Stopped'],
    [RUN_LIFECYCLE_READY, 'Ready'],
  ];

  it.each(wordingCases)('preserves wording: %s -> "%s"', (status, label) => {
    expect(formatRunStatusLabel(status)).toBe(label);
  });

  it('preserves the STARTING wording', () => {
    expect(
      formatRunStatusLabel(RUN_PHASE.RUNNING, {
        substate: RUN_SUBSTATE.STARTING,
      }),
    ).toBe('Initializing');
  });

  it('supports an explicit missing label', () => {
    expect(formatRunStatusLabel(undefined, { missingLabel: '-' })).toBe('-');
  });

  it('uses substate display keys for current running phases', () => {
    expect(
      formatRunStatusLabel(RUN_PHASE.RUNNING, {
        substate: RUN_SUBSTATE.RESUMING,
      }),
    ).toBe('Resuming');
    expect(
      progressHeaderStatus(RUN_PHASE.RUNNING, RUN_SUBSTATE.RESUMING)
        .displayKey,
    ).toBe('resuming');
  });

  it.each([
    [RUN_PHASE.RUNNING, RUN_PHASE.RUNNING],
    [RUN_PHASE.COMPLETED, RUN_PHASE.COMPLETED],
    [RUN_PHASE.CANCELLED, RUN_PHASE.CANCELLED],
    [RUN_PHASE.FAILED, RUN_PHASE.FAILED],
    [RUN_PHASE.WAITING, RUN_PHASE.WAITING],
    [RUN_LIFECYCLE_READY, 'ready'],
  ] as const)('maps lifecycle status %s to display key %s', (status, key) => {
    expect(progressHeaderStatus(status).displayKey).toBe(key);
  });
});
