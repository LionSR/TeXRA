import { describe, expect, it } from 'vitest';

import { tipRowText } from '@cli/chat/tui/panes/TipRow';

describe('CLI TipRow', () => {
  it('keeps root agent tips hidden after agent selection closes', () => {
    expect(
      tipRowText({ agentSelectionAvailable: false, hour: 2 }),
    ).not.toContain('/agent');
  });

  it('shows root agent selection as an up-front setup action', () => {
    expect(tipRowText({ agentSelectionAvailable: true, hour: 2 })).toBe(
      'Press /agent to choose the root agent',
    );
  });

  it('only shows the queued follow-up tip while a response is active', () => {
    expect(tipRowText({ hour: 7, responseRunning: true })).toBe(
      'Type while a response is running to queue a follow-up',
    );
    expect(tipRowText({ hour: 7, responseRunning: false })).toBe(
      'Press Ctrl-R to search your input history',
    );
  });

  it('shows queued follow-up guidance for any active response', () => {
    expect(tipRowText({ hour: 9, responseRunning: true })).toBe(
      'Type while a response is running to queue a follow-up',
    );
    expect(tipRowText({ hour: 9, responseRunning: false })).toBe(
      'Use /resume to continue a previous session',
    );
  });
});
