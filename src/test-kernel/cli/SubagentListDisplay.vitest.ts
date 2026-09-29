import { describe, expect, it } from 'vitest';

import {
  childRowMetadataText,
  pendingApprovalRowDisplay,
} from '@cli/chat/tui/panes/SubagentListDisplay';

describe('CLI child list display model', () => {
  it('summarizes what a row is waiting on from its pending approval kinds', () => {
    expect(pendingApprovalRowDisplay(undefined)).toBeUndefined();
    expect(pendingApprovalRowDisplay([])).toBeUndefined();
    expect(pendingApprovalRowDisplay(['bash'])).toEqual({
      label: 'bash',
      overflow: undefined,
    });
    expect(
      pendingApprovalRowDisplay(['toolEdit', 'bash', 'userQuestion']),
    ).toEqual({ label: 'edit', overflow: '+2' });
  });

  it('formats the row metadata column from elapsed, tool calls and generated tokens', () => {
    expect(
      childRowMetadataText({
        elapsed: '2m 30s',
        outputTokens: 39_900,
        toolCallCount: 5,
      }),
    ).toBe('2m 30s · 5 tool calls · ↓40k');
    expect(
      childRowMetadataText({ elapsed: undefined, outputTokens: 512 }),
    ).toBe('↓512');
    // Zero tokens or tool calls is "nothing yet", not a datum worth a column.
    expect(
      childRowMetadataText({
        elapsed: '45s',
        outputTokens: 0,
        toolCallCount: 0,
      }),
    ).toBe('45s');
    expect(
      childRowMetadataText({ elapsed: null, outputTokens: 0 }),
    ).toBeUndefined();
  });
});
