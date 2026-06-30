import { describe, expect, it } from 'vitest';

import { STREAM_STATUS } from '@shared/schemas';
import {
  type StreamStatusLabelStyle,
  formatStreamStatusLabel,
} from '@shared/streams/streamStatusDisplay';

describe('stream status display labels', () => {
  const wordingCases: Array<[StreamStatusLabelStyle, string, string]> = [
    ['cli', STREAM_STATUS.INITIALIZING, 'starting\u2026'],
    ['cli', STREAM_STATUS.WAITING, 'idle'],
    ['cliCompact', STREAM_STATUS.INITIALIZING, 'starting'],
    ['cliCompact', STREAM_STATUS.WAITING, 'idle'],
    ['progressHeader', STREAM_STATUS.WAITING, 'Waiting for follow-up'],
    ['progressHeader', STREAM_STATUS.INITIALIZING, 'Initializing'],
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
});
