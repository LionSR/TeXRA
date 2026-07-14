import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childStatusColor,
  resolveSessionSelectionId,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  compactChildRowText,
  subagentListRowAllocation,
} from '@cli/chat/tui/panes/SubagentList';
import {
  nextSelectHighlightIndex,
  selectControlledHighlightIndex,
  visibleSelectRange,
  type SelectItem,
} from '@cli/chat/tui/ui/Select';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';

function session(id: string, active = false): StreamView {
  return {
    id: id as StreamTabId,
    label: id,
    slice: undefined,
    active,
  };
}

describe('CLI session list display model', () => {
  it('keeps status markers steady and status colors independent of focus', () => {
    expect(CHILD_STATUS_MARKER).toBe('● ');
    expect(childStatusColor(undefined)).toBe('green');
    expect(childStatusColor('running')).toBe('green');
    expect(childStatusColor('waiting')).toBe('yellow');
    expect(childStatusColor('error')).toBe('red');
    expect(childStatusColor('failed')).toBe('red');
    expect(childStatusColor('exit 2')).toBe('red');
    expect(childStatusColor('stopped')).toBe('gray');
    expect(childStatusColor(STREAM_PHASE.CANCELLED)).toBe('gray');
    expect(childStatusColor(STREAM_PHASE.COMPLETED)).toBe('green');
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

  it('preserves selection by stream id as rows change', () => {
    const selected = 'lean' as StreamTabId;
    const reordered = [
      session('review'),
      session('main', true),
      session('lean'),
    ];

    expect(
      resolveSessionSelectionId(reordered, selected, 'main' as StreamTabId),
    ).toBe(selected);
    expect(
      resolveSessionSelectionId(
        reordered.slice(0, 2),
        selected,
        'main' as StreamTabId,
      ),
    ).toBe('main');
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

  it('keeps a non-first selected row visible after the row budget shrinks', () => {
    const sessions = [
      session('main', true),
      session('strategy'),
      session('lean'),
      session('review'),
    ];
    const selected = sessions[2]?.id;
    const selectedIndex = sessions.findIndex(({ id }) => id === selected);

    expect(
      visibleSelectRange({
        highlight: selectedIndex,
        itemCount: sessions.length,
        maxVisibleItems: 2,
      }),
    ).toEqual({ start: 1, end: 3 });
    expect(
      visibleSelectRange({
        highlight: selectedIndex,
        itemCount: sessions.length,
        maxVisibleItems: 1,
      }),
    ).toEqual({ start: 2, end: 3 });
  });

  it('keeps bounded process rows to the latest one-line output summary', () => {
    expect(
      compactChildRowText({
        child: {
          kind: 'process',
          executionId: 'latexmk',
          agentName: 'latex build',
          status: 'running',
          elapsed: '19sec',
        },
        nowMs: Date.now(),
        tail: {
          stdout:
            'latexmk: applying rule pdflatex\nmain.tex: Proof sketch needs one missing reference',
          stderr: '',
        },
      }),
    ).toBe(
      'latex build running · 19sec · main.tex: Proof sketch needs one missing reference',
    );
  });

  it('reserves constrained-list visibility for sessions and processes', () => {
    expect(
      subagentListRowAllocation({
        maxRows: 3,
        processCount: 4,
        sessionCount: 4,
      }),
    ).toEqual({ sessionRows: 2, processRows: 1 });
    expect(
      subagentListRowAllocation({
        maxRows: 1,
        processCount: 4,
        sessionCount: 4,
      }),
    ).toEqual({ sessionRows: 1, processRows: 0 });
    expect(
      subagentListRowAllocation({
        maxRows: 2,
        processCount: 4,
        sessionCount: 0,
      }),
    ).toEqual({ sessionRows: 0, processRows: 2 });
  });
});
