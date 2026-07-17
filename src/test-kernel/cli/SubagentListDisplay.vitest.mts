import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  pendingApprovalRowSuffix,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import { compactChildRowText } from '@cli/chat/tui/panes/SubagentList';
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

describe('CLI child list display model', () => {
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

  it('summarizes what a row is waiting on from its pending approval kinds', () => {
    expect(pendingApprovalRowSuffix(undefined)).toBeUndefined();
    expect(pendingApprovalRowSuffix([])).toBeUndefined();
    expect(pendingApprovalRowSuffix(['bash'])).toBe('bash');
    expect(pendingApprovalRowSuffix(['externalInquiry'])).toBe('inquiry');
    expect(pendingApprovalRowSuffix(['toolEdit', 'bash', 'userQuestion'])).toBe(
      'edit +2',
    );
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

  it('drops elapsed from the compact row text when the metadata column owns it', () => {
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
        omitElapsed: true,
      }),
    ).toBe('latex build running');
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
});
