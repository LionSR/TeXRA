// Suites for src/shared/streams (stream metadata, status display).

import { describe, expect, it } from 'vitest';
import {
  type ActiveChildInfo,
  AgentCategory,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type StreamLifecycleStatus,
} from '@shared/schemas';
import {
  formatPhaseStageLabel,
  formatRoundStageLabel,
  formatStageLabel,
  formatStreamStatusLabel,
  progressHeaderStatus,
  type StreamStatusLabelStyle,
} from '@shared/streams/streamStatusDisplay';

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

  it('passes undefined through for streams without a phase', () => {
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
  const wordingCases: Array<
    [StreamStatusLabelStyle, StreamLifecycleStatus, string]
  > = [
    ['cli', STREAM_PHASE.WAITING, 'idle'],
    ['cliCompact', STREAM_PHASE.WAITING, 'idle'],
    ['progressHeader', STREAM_PHASE.WAITING, 'Idle'],
    ['cliCompact', STREAM_PHASE.COMPLETED, 'completed'],
    ['progressHeader', STREAM_PHASE.COMPLETED, 'Completed'],
    ['cliCompact', STREAM_PHASE.CANCELLED, 'stopped'],
    ['progressHeader', STREAM_PHASE.CANCELLED, 'Stopped'],
    ['cli', STREAM_STATUS.READY, 'ready'],
    ['progressHeader', STREAM_STATUS.READY, 'Ready'],
  ];

  it.each(wordingCases)(
    'preserves %s wording: %s -> "%s"',
    (style, status, label) => {
      expect(formatStreamStatusLabel(status, { style })).toBe(label);
    },
  );

  const substateWordingCases: Array<[StreamStatusLabelStyle, string]> = [
    ['cli', 'starting\u2026'],
    ['cliCompact', 'starting'],
    ['progressHeader', 'Initializing'],
  ];

  it.each(substateWordingCases)(
    'preserves %s STARTING wording: "%s"',
    (style, label) => {
      expect(
        formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
          style,
          substate: STREAM_SUBSTATE.STARTING,
        }),
      ).toBe(label);
    },
  );

  it('supports an explicit missing label', () => {
    expect(formatStreamStatusLabel(undefined, { missingLabel: '-' })).toBe('-');
  });

  it('uses substate display keys for current running phases', () => {
    expect(
      formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
        style: 'cli',
        substate: STREAM_SUBSTATE.RESUMING,
      }),
    ).toBe('resuming');
    expect(
      progressHeaderStatus(STREAM_PHASE.RUNNING, STREAM_SUBSTATE.RESUMING)
        .displayKey,
    ).toBe('resuming');
  });

  it.each([
    [STREAM_PHASE.RUNNING, STREAM_PHASE.RUNNING],
    [STREAM_PHASE.COMPLETED, STREAM_PHASE.COMPLETED],
    [STREAM_PHASE.CANCELLED, STREAM_PHASE.CANCELLED],
    [STREAM_PHASE.FAILED, STREAM_PHASE.FAILED],
    [STREAM_PHASE.WAITING, STREAM_PHASE.WAITING],
    [STREAM_STATUS.READY, 'ready'],
  ] as const)('maps lifecycle status %s to display key %s', (status, key) => {
    expect(progressHeaderStatus(status).displayKey).toBe(key);
  });
});
