import { describe, expect, it } from 'vitest';

import { STREAM_STATUS } from '@shared/schemas';
import { formatStreamStatusLabel } from '@shared/streams/streamStatusDisplay';

describe('stream status display labels', () => {
  it('preserves CLI status wording', () => {
    expect(
      formatStreamStatusLabel(STREAM_STATUS.INITIALIZING, { style: 'cli' }),
    ).toBe('starting\u2026');
    expect(
      formatStreamStatusLabel(STREAM_STATUS.WAITING, { style: 'cli' }),
    ).toBe('idle');
  });

  it('preserves compact CLI stream-tab wording', () => {
    expect(
      formatStreamStatusLabel(STREAM_STATUS.INITIALIZING, {
        style: 'cliCompact',
      }),
    ).toBe('starting');
    expect(
      formatStreamStatusLabel(STREAM_STATUS.WAITING, {
        style: 'cliCompact',
      }),
    ).toBe('idle');
  });

  it('preserves progress-view header wording', () => {
    expect(
      formatStreamStatusLabel(STREAM_STATUS.WAITING, {
        style: 'progressHeader',
      }),
    ).toBe('Waiting for follow-up');
    expect(
      formatStreamStatusLabel(STREAM_STATUS.INITIALIZING, {
        style: 'progressHeader',
      }),
    ).toBe('Initializing');
  });

  it('passes through unknown statuses and supports an explicit missing label', () => {
    expect(formatStreamStatusLabel('custom')).toBe('custom');
    expect(formatStreamStatusLabel('')).toBe('');
    expect(formatStreamStatusLabel(undefined, { missingLabel: '-' })).toBe('-');
  });
});
