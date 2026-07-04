import { describe, expect, it } from 'vitest';

import { STREAM_PHASE, STREAM_STATUS, STREAM_SUBSTATE } from '@shared/schemas';
import {
  type StreamStatusLabelStyle,
  formatStreamStatusLabel,
  streamStatusDisplayKey,
  streamStatusIndicatorClass,
} from '@shared/streams/streamStatusDisplay';

describe('stream status display labels', () => {
  const wordingCases: Array<[StreamStatusLabelStyle, string, string]> = [
    ['cli', STREAM_STATUS.INITIALIZING, 'starting\u2026'],
    ['cli', STREAM_STATUS.WAITING, 'idle'],
    ['cliCompact', STREAM_STATUS.INITIALIZING, 'starting'],
    ['cliCompact', STREAM_STATUS.WAITING, 'idle'],
    ['progressHeader', STREAM_STATUS.WAITING, 'Waiting for follow-up'],
    ['progressHeader', STREAM_STATUS.INITIALIZING, 'Initializing'],
    ['cliCompact', STREAM_PHASE.COMPLETED, 'completed'],
    ['progressHeader', STREAM_PHASE.COMPLETED, 'Completed'],
    ['cliCompact', STREAM_STATUS.STOPPED, 'stopped'],
  ];

  it.each(wordingCases)(
    'preserves %s wording: %s -> "%s"',
    (style, status, label) => {
      expect(formatStreamStatusLabel(status, { style })).toBe(label);
    },
  );

  it('passes through unknown statuses and supports an explicit missing label', () => {
    expect(formatStreamStatusLabel('custom')).toBe('custom');
    expect(formatStreamStatusLabel('')).toBe('');
    expect(formatStreamStatusLabel(undefined, { missingLabel: '-' })).toBe('-');
  });

  it('uses substate display keys for current running phases', () => {
    expect(
      formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
        style: 'progressHeader',
        substate: STREAM_SUBSTATE.STARTING,
      }),
    ).toBe('Initializing');
    expect(
      formatStreamStatusLabel(STREAM_PHASE.RUNNING, {
        style: 'cli',
        substate: STREAM_SUBSTATE.RESUMING,
      }),
    ).toBe('resuming');
    expect(
      streamStatusDisplayKey(STREAM_PHASE.RUNNING, STREAM_SUBSTATE.STARTING),
    ).toBe(STREAM_SUBSTATE.STARTING);
    expect(
      streamStatusIndicatorClass(
        STREAM_PHASE.RUNNING,
        STREAM_SUBSTATE.RESUMING,
      ),
    ).toBe('is-resuming');
  });

  it.each([
    [STREAM_STATUS.INITIALIZING, STREAM_SUBSTATE.STARTING, 'is-starting'],
    [STREAM_STATUS.RESUMING, STREAM_SUBSTATE.RESUMING, 'is-resuming'],
    [STREAM_STATUS.STOPPED, STREAM_PHASE.COMPLETED, 'is-completed'],
    [STREAM_STATUS.ERROR, STREAM_PHASE.FAILED, 'is-failed'],
    [STREAM_STATUS.WAITING, STREAM_PHASE.WAITING, 'is-waiting'],
    [STREAM_STATUS.READY, 'ready', 'is-ready'],
  ] as const)(
    'maps legacy %s to display key %s and class %s',
    (status, key, className) => {
      expect(streamStatusDisplayKey(status)).toBe(key);
      expect(streamStatusIndicatorClass(status)).toBe(className);
    },
  );
});
