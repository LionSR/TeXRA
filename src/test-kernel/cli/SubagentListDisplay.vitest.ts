import { describe, expect, it } from 'vitest';

import { pendingApprovalRowDisplay } from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  nextSelectHighlightIndex,
  selectControlledHighlightIndex,
  type SelectItem,
} from '@cli/tui/ui/Select';
import { type RunId } from '@shared/schemas';

function session(
  id: string,
  _active = false,
): { readonly id: RunId; readonly label: string } {
  return { id: id as RunId, label: id };
}

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

  it('moves selection through every session and wraps at the ends', () => {
    const sessions = [
      session('main', true),
      session('lean'),
      session('review'),
    ];
    const items: SelectItem<RunId>[] = sessions.map(({ id, label }) => ({
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
    const selected = 'lean' as RunId;
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
});
