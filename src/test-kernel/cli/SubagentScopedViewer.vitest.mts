import { describe, expect, it } from 'vitest';

import { buildChildStreamEntries } from '@test/support/childStreamEntries';
import { taskDetailItemForExecution } from '@cli/chat/tui/state/childControls';
import {
  buildSubagentListRows,
  subagentListRowStreamId,
} from '@cli/chat/tui/state/subagentListRows';
import { NO_BYPASS, type StreamSlice } from '@cli/chat/tui/state/cliState';
import type { StreamView } from '@cli/chat/tui/state/streamViews';
import type { StreamTabId } from '@shared/schemas';

function slice(overrides: Partial<StreamSlice> = {}): StreamSlice {
  return {
    streamId: 'root',
    category: undefined,
    status: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    entries: [],
    queuedFollowUps: 0,
    queuedFollowUpMessages: [],
    activeProcesses: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: NO_BYPASS,
    ...overrides,
  };
}

function session(id: string): StreamView {
  return { id, label: id, active: false } as StreamView;
}

describe('SubagentList Enter targets (the picker replacement)', () => {
  it('routes Enter on a session row to stream focus, never a detail view', () => {
    const rows = buildSubagentListRows({
      activeProcesses: [],
      childStreamEntries: new Map(),
      parentStreamId: 'root' as StreamTabId,
      sessions: [session('root'), session('reviewer@opus#exec-1')],
      streams: new Map(),
    });

    expect(rows.map(subagentListRowStreamId)).toEqual([
      'root',
      'reviewer@opus#exec-1',
    ]);
  });

  it('routes Enter on a process row to its inline task detail item', () => {
    const parent = slice({
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'proc-1',
          agentName: 'latexmk',
          status: 'running',
        },
      ],
      processOutput: new Map([['proc-1', { stdout: 'built pdf', stderr: '' }]]),
    });
    const streams = new Map<StreamTabId, StreamSlice>([['root', parent]]);
    const rows = buildSubagentListRows({
      activeProcesses: parent.activeProcesses,
      childStreamEntries: new Map(),
      parentStreamId: 'root' as StreamTabId,
      sessions: [],
      streams,
    });

    // Process rows carry no stream to focus — Enter opens TaskDetailView.
    expect(rows.map(subagentListRowStreamId)).toEqual([undefined]);
    expect(
      taskDetailItemForExecution({
        childStreamEntries: buildChildStreamEntries({
          parentStreamId: 'root' as StreamTabId,
        }),
        executionId: 'proc-1',
        parentStreamId: 'root' as StreamTabId,
        streams,
      }),
    ).toMatchObject({
      executionId: 'proc-1',
      kind: 'process',
      label: 'latexmk',
      tailLines: ['built pdf'],
    });
  });

  it('resolves no detail item once the process has exited', () => {
    const streams = new Map<StreamTabId, StreamSlice>([['root', slice()]]);

    expect(
      taskDetailItemForExecution({
        childStreamEntries: buildChildStreamEntries({
          parentStreamId: 'root' as StreamTabId,
        }),
        executionId: 'proc-1',
        parentStreamId: 'root' as StreamTabId,
        streams,
      }),
    ).toBeUndefined();
    expect(
      taskDetailItemForExecution({
        childStreamEntries: buildChildStreamEntries({
          parentStreamId: 'root' as StreamTabId,
        }),
        executionId: 'proc-1',
        parentStreamId: undefined,
        streams,
      }),
    ).toBeUndefined();
  });
});
