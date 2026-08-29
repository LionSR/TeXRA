// The popup paints the shared run model; these tests pin what only the
// terminal decides — that the frame renders around a phase and that a big
// phase windows to the row budget with attention rows first.

import { describe, expect, it, vi } from 'vitest';

import { WorkflowPopup } from '@cli/chat/tui/panes/WorkflowPopup';
import {
  emptySlice,
  type WorkflowPopupView,
} from '@cli/chat/tui/state/cliState';
import type {
  StreamTabId,
  TaskGroup,
  WorkflowCallProgress,
} from '@shared/schemas';
import { workflowRunModel } from '@shared/streams/workflowRunModel';
import type { WorkflowTaskRow } from '@shared/transcript';
import { loadInk, renderInteractive } from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';

const ROOT = 'workflow-root' as StreamTabId;

const VIEW: WorkflowPopupView = {
  phaseIndex: 0,
  selectedKey: undefined,
  expanded: new Set(),
  filter: '',
  filterEditing: false,
};

function taskRow(
  id: string,
  status: WorkflowCallProgress['status'],
): WorkflowTaskRow {
  const call =
    status === 'failed'
      ? { id, label: id, phase: 'Derive', status, error: 'boom' }
      : ({ id, label: id, phase: 'Derive', status } as WorkflowCallProgress);
  return {
    kind: 'workflowTask',
    id: `task-${id}`,
    timestamp: 0,
    level: 'info',
    groupId: 'phase-Derive',
    call,
    line: `${status}: ${id}`,
    statusLabel: status === 'failed' ? 'Failed' : 'Running',
    metadataParts: [],
  };
}

async function renderPopup(
  taskGroups: readonly TaskGroup[],
  rows: readonly WorkflowTaskRow[],
  availableRows: number,
) {
  const slice = { ...emptySlice(ROOT), taskGroups, entries: rows };
  const model = workflowRunModel({
    taskGroups,
    rows,
    plan: undefined,
    runSettled: false,
  });
  const { ink, React } = await loadInk();
  return renderInteractive(
    ink,
    React.createElement(WorkflowPopup, {
      activeSubagentExecutionIds: new Map(),
      availableRows,
      model,
      onClose: vi.fn(),
      onFocusStream: vi.fn(),
      onKillExecution: vi.fn(),
      onOpenTranscript: vi.fn(),
      onViewChange: vi.fn(),
      onWorkflowControl: vi.fn(),
      pendingApprovals: undefined,
      streamId: ROOT,
      streams: new Map([[ROOT, slice]]),
      view: VIEW,
    }),
    { columns: 100 },
  );
}

describe('workflow popup', () => {
  it('renders a frame around a current empty dynamic phase', async () => {
    // A phase the script opened dynamically carries no declared position.
    const { instance, stdout } = await renderPopup(
      [
        {
          id: 'phase-current',
          name: 'Explore',
          startTime: 0,
          status: 'running',
          kind: 'phase',
        },
      ],
      [],
      20,
    );
    try {
      await waitFor(() => stdout.output.includes('Explore'));
      expect(stdout.output).toContain('No calls in this phase yet');
    } finally {
      instance.unmount();
    }
  });

  it('windows a big phase to the row budget with attention rows first', async () => {
    const rows = [
      taskRow('bad', 'failed'),
      ...Array.from({ length: 12 }, (_, index) =>
        taskRow(`run-${index}`, 'running'),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        taskRow(`queued-${index}`, 'queued'),
      ),
    ];
    const { instance, stdout } = await renderPopup(
      [
        {
          id: 'phase-Derive',
          name: 'Derive',
          startTime: 0,
          status: 'running',
          kind: 'phase',
          index: 0,
          total: 1,
        },
      ],
      rows,
      14,
    );
    try {
      await waitFor(() => stdout.output.includes('bad'));
      const lines = stdout.output.split('\n');
      const failedLine = lines.findIndex((line) => line.includes(' bad '));
      const firstRunning = lines.findIndex((line) => line.includes('run-0'));
      expect(failedLine).toBeGreaterThan(-1);
      expect(firstRunning).toBeGreaterThan(failedLine);
      // 13 attention rows cannot all fit; the list says how many are below.
      expect(stdout.output).toMatch(/… \d+ more/);
    } finally {
      instance.unmount();
    }
  });
});
