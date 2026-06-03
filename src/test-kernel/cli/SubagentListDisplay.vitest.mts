import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childStatusColor,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  compactChildRowText,
  compactRows,
} from '@cli/chat/tui/panes/SubagentList';
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
    expect(childStatusColor('stopped')).toBe('red');
  });

  it('uses a compact child row budget instead of clipping nested sections', () => {
    const subagents: ActiveChildInfo[] = [
      { executionId: 'strategy', agentName: 'strategy' },
      { executionId: 'lean', agentName: 'leanSolver' },
      { executionId: 'review', agentName: 'reviewer' },
    ];
    const activeProcesses: ActiveChildInfo[] = [
      { executionId: 'latexmk', agentName: 'latex build', toolName: 'bash' },
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

  it('reserves a single overflowing row for the overflow summary', () => {
    const display = compactRows({
      activeProcesses: [{ executionId: 'latexmk', agentName: 'latex build' }],
      maxRows: 1,
      subagents: [
        { executionId: 'strategy', agentName: 'strategy' },
        { executionId: 'lean', agentName: 'leanSolver' },
      ],
    });

    expect(display.rows).toEqual([]);
    expect(display.hiddenCount).toBe(3);
  });

  it('keeps exact-fit compact rows without adding an overflow summary', () => {
    const subagents: ActiveChildInfo[] = [
      { executionId: 'strategy', agentName: 'strategy' },
      { executionId: 'lean', agentName: 'leanSolver' },
    ];
    const activeProcesses: ActiveChildInfo[] = [
      { executionId: 'latexmk', agentName: 'latex build' },
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
});
