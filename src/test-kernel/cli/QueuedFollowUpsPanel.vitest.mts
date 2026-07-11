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

  it('summarizes queued subagent follow-up payloads', () => {
    const display = queuedFollowUpPanelDisplay({
      messages: [
        '<orchestrator-followup><subagent-result id="child-q" agent="reviewer" category="toolUse" status="completed"><response>All good &lt;ok&gt;</response></subagent-result></orchestrator-followup>',
      ],
      maxRows: 3,
      width: 80,
    });

    expect(display.rows.map((row) => row.text)).toEqual([
      '1. ✓ reviewer completed All good <ok>',
    ]);
  });

  // Regression coverage (issue #7679, codex P2): the recognizer in
  // subagentFollowup.ts is derived from the full DELIVERY_TAGS vocabulary,
  // not just `<subagent-*>` — agent-CLI child-run families (codex,
  // claude-agent) must also render summarized here instead of raw XML.
  it('summarizes queued claude-agent-result follow-up payloads', () => {
    const display = queuedFollowUpPanelDisplay({
      messages: [
        '<orchestrator-followup><claude-agent-result id="child-q" session-id="s1"><response>Done.</response></claude-agent-result></orchestrator-followup>',
      ],
      maxRows: 3,
      width: 80,
    });

    expect(display.rows.map((row) => row.text)).toEqual([
      '1. ✓ claude-agent completed Done.',
    ]);
  });

  it('keeps malformed queued follow-up entries renderable', () => {
    const display = queuedFollowUpPanelDisplay({
      messages: [undefined as unknown as string],
      maxRows: 3,
      width: 80,
    });

    expect(display.rows.map((row) => row.text)).toEqual([
      '1. (empty follow-up)',
    ]);
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
      '… +2 more queued',
    ]);
    expect(display.hiddenCount).toBe(2);
  });

  it('uses an overflow row when only one message slot fits', () => {
    const display = queuedFollowUpPanelDisplay({
      messages: ['first', 'second'],
      maxRows: 2,
      width: 80,
    });

    expect(display.rows.map((row) => row.text)).toEqual(['… +2 more queued']);
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
