import { describe, expect, it } from 'vitest';

import { queuedFollowUpsSummary } from '@cli/chat/tui/panes/StatusBar';

describe('queuedFollowUpsSummary', () => {
  it('previews the first two queued follow-ups when space allows', () => {
    const summary = queuedFollowUpsSummary(
      [
        'Check a finite group problem using the harness',
        'Ask the strategy subagent to compare two proof outlines',
      ],
      48,
    );

    expect(summary).toContain('1.');
    expect(summary).toContain('2.');
    expect(summary).toContain(' · ');
    expect(summary?.length).toBeLessThanOrEqual(48);
  });

  it('omits the queued preview when the status bar has no useful space', () => {
    expect(
      queuedFollowUpsSummary(
        ['Check a finite group problem', 'Ask the strategy subagent'],
        12,
      ),
    ).toBeUndefined();
  });
});
