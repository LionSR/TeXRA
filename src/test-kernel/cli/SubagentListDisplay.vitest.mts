import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childStatusColor,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  compactChildRowText,
  compactRows,
} from '@cli/chat/tui/panes/SubagentList';
import { STREAM_PHASE } from '@shared/schemas';
import type { ActiveChildInfo } from '@shared/schemas';

describe('CLI SubagentList display model', () => {
  it('renders a steady (non-animated) marker for every status', () => {
    // The marker is intentionally static: a blinking dot forced the whole live
    // region to repaint twice a second, which surfaced Ink repaint residue.
    expect(CHILD_STATUS_MARKER).toBe('● ');
  });

  it('maps status colors consistently', () => {
    expect(childStatusColor(undefined)).toBe('green');
    expect(childStatusColor('running')).toBe('green');
    expect(childStatusColor('waiting')).toBe('yellow');
    expect(childStatusColor('error')).toBe('red');
    expect(childStatusColor('failed')).toBe('red');
    expect(childStatusColor('exit 2')).toBe('red');
    // A user stop is not an error: neutral (gray), not red, matching the
    // progress view / webview and the canonical RUN_OUTCOME (cancelled ≠ failed).
    expect(childStatusColor('stopped')).toBe('gray');
  });

  it('uses a compact child row budget instead of clipping nested sections', () => {
    const subagents: ActiveChildInfo[] = [
      {
        kind: 'subagent',
        executionId: 'strategy',
        agentName: 'strategy',
        childStreamId: 'strategy-stream',
      },
      {
        kind: 'subagent',
        executionId: 'lean',
        agentName: 'leanSolver',
        childStreamId: 'lean-stream',
      },
      {
        kind: 'subagent',
        executionId: 'review',
        agentName: 'reviewer',
        childStreamId: 'review-stream',
      },
    ];
    const activeProcesses: ActiveChildInfo[] = [
      {
        kind: 'process',
        executionId: 'latexmk',
        agentName: 'latex build',
        toolName: 'bash',
      },
    ];

    const display = compactRows({
      activeProcesses,
      maxRows: 3,
      subagents,
    });

    expect(display.rows.map((row) => row.child.executionId)).toEqual([
      'strategy',
      'lean',
    ]);
    expect(display.hiddenCount).toBe(2);
  });

  it('uses the single available row for the highest-signal item', () => {
    // Mirrors TodosPlanPanel's `compactTodosPlanRows` tie-break: at one row,
    // show the top-priority row instead of spending it on the overflow
    // marker.
    const display = compactRows({
      activeProcesses: [
        { kind: 'process', executionId: 'latexmk', agentName: 'latex build' },
      ],
      maxRows: 1,
      subagents: [
        {
          kind: 'subagent',
          executionId: 'strategy',
          agentName: 'strategy',
          childStreamId: 'strategy-stream',
        },
        {
          kind: 'subagent',
          executionId: 'lean',
          agentName: 'leanSolver',
          childStreamId: 'lean-stream',
        },
      ],
    });

    expect(display.rows.map((row) => row.child.executionId)).toEqual([
      'strategy',
    ]);
    expect(display.hiddenCount).toBe(2);
  });

  it('spends zero rows on real content at a zero row budget', () => {
    const display = compactRows({
      activeProcesses: [],
      maxRows: 0,
      subagents: [
        {
          kind: 'subagent',
          executionId: 'strategy',
          agentName: 'strategy',
          childStreamId: 'strategy-stream',
        },
      ],
    });

    expect(display.rows).toEqual([]);
    expect(display.hiddenCount).toBe(1);
  });

  it('keeps exact-fit compact rows without adding an overflow summary', () => {
    const subagents: ActiveChildInfo[] = [
      {
        kind: 'subagent',
        executionId: 'strategy',
        agentName: 'strategy',
        childStreamId: 'strategy-stream',
      },
      {
        kind: 'subagent',
        executionId: 'lean',
        agentName: 'leanSolver',
        childStreamId: 'lean-stream',
      },
    ];
    const activeProcesses: ActiveChildInfo[] = [
      { kind: 'process', executionId: 'latexmk', agentName: 'latex build' },
    ];

    const display = compactRows({
      activeProcesses,
      maxRows: 3,
      subagents,
    });

    expect(display.rows.map((row) => row.child.executionId)).toEqual([
      'strategy',
      'lean',
      'latexmk',
    ]);
    expect(display.hiddenCount).toBe(0);
  });

  it('summarizes the latest process output in compact rows', () => {
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

  it('uses CLI-facing labels for child stream statuses', () => {
    expect(
      compactChildRowText({
        child: {
          kind: 'process',
          executionId: 'review',
          agentName: 'review',
          status: STREAM_PHASE.WAITING,
        },
        nowMs: Date.now(),
      }),
    ).toBe('review waiting for you');
  });
});
