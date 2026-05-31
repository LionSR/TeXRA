import { describe, expect, it } from 'vitest';

import {
  queuedFollowUpPanelDisplay,
  queuedFollowUpPanelRowCount,
} from '@cli/chat/tui/panes/QueuedFollowUpsPanel';

describe('CLI queued follow-up panel display model', () => {
  it('uses no rows when there are no queued follow-ups', () => {
    expect(queuedFollowUpPanelRowCount([])).toBe(0);
    expect(
      queuedFollowUpPanelDisplay({ messages: [], maxRows: 3, width: 80 }),
    ).toEqual({ title: undefined, rows: [], hiddenCount: 0 });
  });

  it('uses a compact title plus readable message rows', () => {
    expect(queuedFollowUpPanelRowCount(['first', 'second'])).toBe(3);

    const display = queuedFollowUpPanelDisplay({
      messages: ['First queued follow-up', 'Second queued follow-up'],
      maxRows: 3,
      width: 80,
    });

    expect(display.title).toBe('Queued follow-ups (2)');
    expect(display.rows.map((row) => row.text)).toEqual([
      '1. First queued follow-up',
      '2. Second queued follow-up',
    ]);
    expect(display.hiddenCount).toBe(0);
  });

  it('keeps the panel bounded when more messages are queued', () => {
    expect(queuedFollowUpPanelRowCount(['first', 'second', 'third'])).toBe(3);

    const display = queuedFollowUpPanelDisplay({
      messages: ['first', 'second', 'third'],
      maxRows: 3,
      width: 80,
    });

    expect(display.rows.map((row) => row.text)).toEqual([
      '1. first',
      '… 2 more queued',
    ]);
    expect(display.hiddenCount).toBe(2);
  });

  it('keeps hidden count nonnegative when callers pass extra rows', () => {
    const display = queuedFollowUpPanelDisplay({
      messages: ['only queued follow-up'],
      maxRows: 5,
      width: 80,
    });

    expect(display.rows.map((row) => row.text)).toEqual([
      '1. only queued follow-up',
    ]);
    expect(display.hiddenCount).toBe(0);
  });

  it('truncates wide messages by terminal columns', () => {
    const display = queuedFollowUpPanelDisplay({
      messages: ['Please keep the proof under one page.'],
      maxRows: 2,
      width: 24,
    });

    expect(display.rows.map((row) => row.text)).toEqual([
      '1. Please keep the pr…',
    ]);
  });
});
