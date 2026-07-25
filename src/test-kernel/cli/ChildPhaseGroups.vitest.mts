import { describe, expect, it } from 'vitest';

import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  childPhaseGroupRows,
  orderChildIdsByPhase,
} from '@cli/chat/tui/state/childPhaseGroups';
import { streamTreeEntries } from '@cli/chat/tui/state/streamViews';
import {
  STREAM_PHASE,
  type StreamTabId,
  type WorkflowTaskProgress,
} from '@shared/schemas';
import { buildChildStreamEntries } from '@test/support/childStreamEntries';

const run = 'run' as StreamTabId;

function slice(streamId: StreamTabId): StreamSlice {
  return {
    streamId,
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    compactingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    todos: [],
    plan: null,
    bypass: NO_BYPASS,
  };
}

function task(
  label: string,
  phase: string,
  status: 'completed' | 'running',
): WorkflowTaskProgress {
  return { id: label, label, phase, status };
}

/** Roster fixture: `agent()` grandchildren of one workflow-script run, in
 *  creation order, each optionally stamped with its owning phase. */
function workflowRunChildren(
  children: readonly { readonly id: string; readonly phase?: string }[],
) {
  return buildChildStreamEntries({
    parentStreamId: run,
    retained: children.map((child) => ({
      kind: 'subagent' as const,
      executionId: `${child.id}-exec`,
      agentName: 'writer',
      childStreamId: child.id as StreamTabId,
      status: STREAM_PHASE.COMPLETED,
      ...(child.phase === undefined ? {} : { workflowPhase: child.phase }),
    })),
  });
}

function treeEntriesFor(
  children: readonly { readonly id: string; readonly phase?: string }[],
) {
  const streams = new Map<StreamTabId, StreamSlice>([[run, slice(run)]]);
  for (const child of children) {
    streams.set(child.id as StreamTabId, slice(child.id as StreamTabId));
  }
  return streamTreeEntries({
    activeStreamId: run,
    childStreamEntries: workflowRunChildren(children),
    parentStream: new Map(
      children.map((child) => [child.id as StreamTabId, run]),
    ),
    rootStreamId: run,
    streams,
  });
}

describe('CLI child phase grouping', () => {
  it('leaves a phase-less list untouched, array identity included', () => {
    const ids = ['a', 'b', 'c'];
    expect(orderChildIdsByPhase(ids, () => undefined)).toBe(ids);
  });

  it('makes same-phase entries contiguous by first-seen phase position', () => {
    const ids = ['r1', 'm1', 'r2', 'm2', 'm3'];
    const phases = new Map([
      ['r1', 'Reduce'],
      ['r2', 'Reduce'],
      ['m1', 'Map'],
      ['m2', 'Map'],
      ['m3', 'Map'],
    ]);
    // `Reduce` is first-seen at position 0, `Map` at 1, and neither group's
    // internal order moves.
    expect(orderChildIdsByPhase(ids, (id) => phases.get(id))).toEqual([
      'r1',
      'r2',
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('keeps phase-less entries at their own rank between groups', () => {
    const ids = ['p1', 'bare', 'p2'];
    const phases = new Map([
      ['p1', 'Map'],
      ['p2', 'Map'],
    ]);
    expect(orderChildIdsByPhase(ids, (id) => phases.get(id))).toEqual([
      'p1',
      'p2',
      'bare',
    ]);
  });

  it('heads each group with the shared phase heading and its task progress', () => {
    const rows = childPhaseGroupRows({
      rows: [
        { id: 'run' },
        { id: 'a', workflowPhase: 'Map' },
        { id: 'b', workflowPhase: 'Map' },
        { id: 'c', workflowPhase: 'Reduce' },
      ],
      phases: [
        { phaseLabel: 'Map', phaseIndex: 0, phaseTotal: 3 },
        { phaseLabel: 'Reduce', phaseIndex: 1, phaseTotal: 3 },
      ],
      tasks: [
        task('extract-2', 'Map', 'completed'),
        task('extract-3', 'Map', 'completed'),
        task('merge', 'Reduce', 'running'),
        task('rank', 'Reduce', 'running'),
        task('draft', 'Reduce', 'running'),
      ],
    });

    expect(
      rows.map((row) =>
        row.kind === 'header'
          ? [row.header.label, row.header.progress]
          : row.row.id,
      ),
    ).toEqual([
      'run',
      ['◆ Map (1/3)', '2/2'],
      'a',
      'b',
      ['◆ Reduce (2/3)', '0/3'],
      'c',
    ]);
  });

  it('omits the counts suffix and the progress a phase has no data for', () => {
    const rows = childPhaseGroupRows({
      rows: [{ id: 'a', workflowPhase: 'Ad hoc' }],
    });
    expect(rows).toEqual([
      {
        kind: 'header',
        header: { phase: 'Ad hoc', label: '◆ Ad hoc' },
      },
      { kind: 'row', row: { id: 'a', workflowPhase: 'Ad hoc' } },
    ]);
  });

  it('emits no header for rows that carry no phase', () => {
    const rows: readonly {
      readonly id: string;
      readonly workflowPhase?: string;
    }[] = [{ id: 'a' }, { id: 'b' }];
    expect(childPhaseGroupRows({ rows })).toEqual([
      { kind: 'row', row: { id: 'a' } },
      { kind: 'row', row: { id: 'b' } },
    ]);
  });

  it('counts one task per logical call even when a retry adds a row', () => {
    // A durable retry registers a *new* child stream under the same phase, so
    // the group holds two rows while its header counts the one task card.
    const rows = childPhaseGroupRows({
      rows: [
        { id: 'attempt-1', workflowPhase: 'Map' },
        { id: 'attempt-2', workflowPhase: 'Map' },
      ],
      tasks: [task('extract', 'Map', 'completed')],
    });
    expect(rows.filter((row) => row.kind === 'header')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'row')).toHaveLength(2);
    expect(
      rows[0]?.kind === 'header' ? rows[0].header.progress : undefined,
    ).toBe('1/1');
  });

  it('assigns Alt+1..9 from the grouped order, one owner for both', () => {
    // Newest-first before grouping: m3, r2, m2, r1, m1. Grouping keeps that
    // ordering rule — the newest row's phase heads the list and each group
    // stays newest-first — and only makes each phase contiguous. Shortcuts are
    // numbered from the grouped positions by the same function that produced
    // them, so Alt+N and the visible order cannot drift apart.
    const grouped = treeEntriesFor([
      { id: 'm1', phase: 'Map' },
      { id: 'r1', phase: 'Reduce' },
      { id: 'm2', phase: 'Map' },
      { id: 'r2', phase: 'Reduce' },
      { id: 'm3', phase: 'Map' },
    ]);
    expect(grouped).toEqual([
      { id: run },
      { id: 'm3', shortcutIndex: 1 },
      { id: 'm2', shortcutIndex: 2 },
      { id: 'm1', shortcutIndex: 3 },
      { id: 'r2', shortcutIndex: 4 },
      { id: 'r1', shortcutIndex: 5 },
    ]);
  });

  it('leaves a list with no workflow phase byte-identical to newest-first', () => {
    expect(treeEntriesFor([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual([
      { id: run },
      { id: 'c', shortcutIndex: 1 },
      { id: 'b', shortcutIndex: 2 },
      { id: 'a', shortcutIndex: 3 },
    ]);
  });
});
