import { describe, expect, it } from 'vitest';

import {
  childRowMetadataText,
  pendingApprovalRowDisplay,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  nextSelectHighlightIndex,
  selectControlledHighlightIndex,
  type SelectItem,
} from '@cli/tui/ui/Select';
import { type StreamTabId } from '@shared/schemas';

function session(
  id: string,
  _active = false,
): { readonly id: StreamTabId; readonly label: string } {
  return { id: id as StreamTabId, label: id };
}

describe('CLI child list display model', () => {
  it('summarizes what a row is waiting on from its pending approval kinds', () => {
    expect(pendingApprovalRowDisplay(undefined)).toBeUndefined();
    expect(pendingApprovalRowDisplay([])).toBeUndefined();
    expect(pendingApprovalRowDisplay(['bash'])).toEqual({
      label: 'bash',
      overflow: undefined,
    });
    expect(pendingApprovalRowDisplay(['externalInquiry'])).toEqual({
      label: 'inquiry',
      overflow: undefined,
    });
    expect(
      pendingApprovalRowDisplay(['toolEdit', 'bash', 'userQuestion']),
    ).toEqual({ label: 'edit', overflow: '+2' });
  });

  it('moves selection through every session and wraps at the ends', () => {
    const sessions = [
      session('main', true),
      session('lean'),
      session('review'),
    ];
    const items: SelectItem<StreamTabId>[] = sessions.map(({ id, label }) => ({
      label,
      value: id,
    }));

    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 0,
        items,
      }),
    ).toBe(1);
    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 0,
        items,
      }),
    ).toBe(2);
  });

  it('relocates a controlled highlight after a same-length reorder', () => {
    const selected = 'lean' as StreamTabId;
    const items = [session('main'), session('lean'), session('review')].map(
      ({ id, label }) => ({ label, value: id }),
    );
    const reordered = [items[2]!, items[0]!, items[1]!];

    expect(
      selectControlledHighlightIndex({
        highlightedValue: selected,
        items: reordered,
        previousIndex: 1,
      }),
    ).toBe(2);
  });

  it('formats the row metadata column from elapsed and generated tokens', () => {
    expect(
      childRowMetadataText({ elapsed: '2m 30s', outputTokens: 39_900 }),
    ).toBe('2m 30s · ↓40k');
    expect(
      childRowMetadataText({ elapsed: '45s', outputTokens: undefined }),
    ).toBe('45s');
    expect(
      childRowMetadataText({ elapsed: undefined, outputTokens: 512 }),
    ).toBe('↓512');
    // Zero tokens is "nothing generated yet", not a datum worth a column.
    expect(
      childRowMetadataText({ elapsed: null, outputTokens: 0 }),
    ).toBeUndefined();
  });

  it('adds the tool-call count between elapsed and generated tokens', () => {
    expect(
      childRowMetadataText({
        elapsed: '2m 30s',
        outputTokens: 39_900,
        toolCallCount: 5,
      }),
    ).toBe('2m 30s · 5 tool calls · ↓40k');
    expect(
      childRowMetadataText({
        elapsed: '45s',
        outputTokens: undefined,
        toolCallCount: 1,
      }),
    ).toBe('45s · 1 tool call');
    // No tool calls yet is not a datum worth a column segment.
    expect(
      childRowMetadataText({
        elapsed: '45s',
        outputTokens: undefined,
        toolCallCount: 0,
      }),
    ).toBe('45s');
  });
});
