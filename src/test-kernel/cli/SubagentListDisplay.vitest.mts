import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childStatusColor,
  shouldShowChildSectionHeader,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import { compactRows } from '@cli/chat/tui/panes/SubagentList';
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
    expect(childStatusColor('stopped')).toBe('red');
  });

  it('uses section headers only in the unbounded child list', () => {
    expect(shouldShowChildSectionHeader(undefined)).toBe(true);
    expect(shouldShowChildSectionHeader(2)).toBe(false);
    expect(shouldShowChildSectionHeader(1)).toBe(false);
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
      processOutput: new Map(),
      subagents,
    });

    expect(display.rows.map((row) => row.child.executionId)).toEqual([
      'strategy',
      'lean',
    ]);
    expect(display.hiddenCount).toBe(2);
  });
});
