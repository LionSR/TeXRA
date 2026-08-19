import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { ConversationPane } from '@cli/chat/tui/panes/ConversationPane';
import { selectWorkflowRunDetailLines } from '@cli/chat/tui/panes/WorkflowRunDetails';
import {
  bindChildStreamState,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import {
  activeStreamId,
  patchStream,
  resetCliState,
  setStreamStatusInCliState,
} from '@cli/chat/tui/state/cliState';
import { SessionState } from '@controllers/session/SessionState';
import {
  AgentCategory,
  type CompileFailure,
  LOG_LEVELS,
  type OutputFileInfo,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
} from '@shared/schemas';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import { loadInk } from '@test/support/inkTestHarness.ts';
import { textRowFixture } from '@test/support/transcriptRowFixtures';

/** Test-local full replay through the production reducer (the resync path). */
function projectTaskGroupsFromStreamLog(
  entries: Iterable<StreamLogEntry>,
): TaskGroup[] {
  const taskGroups: TaskGroup[] = [];
  const taskGroupIndex = new Map<string, number>();
  for (const entry of entries) {
    upsertTaskGroupFromStreamLog(taskGroups, taskGroupIndex, entry);
  }
  return taskGroups;
}

const STREAM_ID = 'workflow#details' as StreamTabId;

const COMPILE_FAILURE: CompileFailure = {
  round: 0,
  displayName: 'paper.pdf',
  output: {
    kind: 'external',
    absolutePath: '/tmp/paper.pdf',
  },
  log: {
    kind: 'external',
    absolutePath: '/tmp/paper.log',
  },
  logRelativePath: 'paper.log',
};

const COMPILE_FAILURES_BY_ROUND = { 0: [COMPILE_FAILURE] };

function completedRound(
  index: number,
  total: number,
  startTime: number,
  endTime: number,
): TaskGroup {
  return {
    id: `r${index}`,
    name: `r${index}`,
    kind: 'round' as const,
    index,
    total,
    startTime,
    endTime,
    status: STREAM_PHASE.COMPLETED,
  };
}

function generatedFile(
  relativePath: string,
  diff: { added: number; removed: number } | null,
): OutputFileInfo {
  return {
    source: 'paper.tex',
    round: 0,
    location: {
      kind: 'workspace' as const,
      absolutePath: `/workspace/${relativePath}`,
      relativePath,
    },
    lineage: null,
    diff,
  };
}

// Agent category is shared-substrate metadata now: `ConversationPane` reads it
// via `streamMetadataFor` from the bound `SessionState`, whose authority is
// the durable summary mirror.
let boundState: SessionState | undefined;

function seedWorkflowCategory(streamId: StreamTabId): void {
  boundState = new SessionState(defaultSession());
  bindChildStreamState(boundState);
  defaultSession().transcripts.recordSummaryMeta(streamId, {
    agentCategory: AgentCategory.Workflow,
  });
}

afterEach(() => {
  if (boundState) {
    unbindChildStreamState(boundState);
    boundState = undefined;
  }
  resetCliState();
});

describe('selectWorkflowRunDetailLines', () => {
  it('joins lifecycle, planned rounds, generated files, and warnings', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: [
          {
            id: 'run',
            name: 'Repository audit',
            kind: 'run',
            startTime: 1_000,
            endTime: 10_000,
            status: STREAM_PHASE.COMPLETED,
          },
          completedRound(0, 2, 2_000, 9_200),
        ],
        outputFilesByRound: {
          0: [generatedFile('output/paper.tex', { added: 12, removed: 3 })],
        },
        missingOutputsByRound: { 0: ['appendix.tex'] },
        compileFailuresByRound: COMPILE_FAILURES_BY_ROUND,
      },
      100,
    );

    expect(lines.map((line) => line.text)).toEqual([
      '✓ Repository audit Finished · 9s',
      '✓ r1/2 Finished · 7s',
      '  Generated files',
      '    • paper.tex (+12 -3)',
      '  ⚠ r1 · Missing expected output: appendix.tex',
      '  ✗ r1 · Compile check failed: paper.pdf · paper.log',
      '□ r2/2 Planned',
    ]);
    expect(lines.map((line) => line.tone)).toEqual([
      'success',
      'success',
      'muted',
      'neutral',
      'warning',
      'error',
      'muted',
    ]);
  });

  it('shows the full path for external generated files', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: [completedRound(0, 1, 0, 1)],
        outputFilesByRound: {
          0: [
            {
              source: 'paper.tex',
              round: 0,
              location: {
                kind: 'external',
                absolutePath: '/tmp/external-output/paper.tex',
              },
              lineage: null,
              diff: null,
            },
          ],
        },
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      },
      100,
    );

    expect(lines.map((line) => line.text)).toContain(
      '    • /tmp/external-output/paper.tex',
    );
  });

  it('renders a typed round and sanitizes terminal controls', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: projectTaskGroupsFromStreamLog([
          {
            seqNo: 1,
            id: 'round-3',
            type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
            level: LOG_LEVELS.INFO,
            timestamp: 0,
            text: 'r3',
            data: { status: STREAM_PHASE.RUNNING, kind: 'round', index: 3 },
          },
        ]),
        outputFilesByRound: {},
        missingOutputsByRound: { 3: ['bad\u001b[31m.tex'] },
        compileFailuresByRound: {},
      },
      100,
    );

    expect(lines.map((line) => line.text)).toEqual([
      '● r4 Running',
      '  ⚠ r4 · Missing expected output: bad.tex',
    ]);
  });

  it('shows a round-qualified alert when only one detail row fits', () => {
    const [line] = selectWorkflowRunDetailLines(
      {
        taskGroups: [
          {
            id: 'r0',
            name: 'r0',
            kind: 'round',
            index: 0,
            startTime: 0,
            endTime: 1_000,
            status: STREAM_PHASE.COMPLETED,
          },
        ],
        outputFilesByRound: {},
        missingOutputsByRound: { 0: ['missing.tex'] },
        compileFailuresByRound: COMPILE_FAILURES_BY_ROUND,
      },
      1,
    );

    expect(line?.text).toBe(
      '  ✗ r1 · Compile check failed: paper.pdf · paper.log',
    );
    expect(line?.role).toBe('alert');
  });

  it.each([
    ['unclassified', undefined],
    ['round without an index', 'round'],
    ['session stage', 'session'],
  ] as const)('keeps a %s lifecycle group visible', (_case, kind) => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: projectTaskGroupsFromStreamLog([
          {
            seqNo: 1,
            id: 'legacy-round',
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            level: LOG_LEVELS.INFO,
            timestamp: 0,
            text: 'Round 3',
            data: { status: 'stopped', endTime: 1_000, kind },
          },
        ]),
        outputFilesByRound: {},
        missingOutputsByRound: {},
        compileFailuresByRound: {},
      },
      100,
    );

    expect(lines.map((line) => line.text)).toEqual(['✓ Round 3 Finished · 1s']);
  });

  it('budgets detail rows together with the live transcript viewport', async () => {
    seedWorkflowCategory(STREAM_ID);
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      taskGroups: [
        {
          id: 'r0',
          name: 'r0',
          kind: 'round',
          index: 0,
          total: 4,
          startTime: 0,
          status: STREAM_PHASE.RUNNING,
        },
      ],
      // A live (not yet settled) log row: no settlement order, and the
      // slice's `finalizedFrontier` still at 0.
      entries: [textRowFixture('live', 'log', 'live workflow log')],
    }));
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.RUNNING,
    });
    activeStreamId.set(STREAM_ID);

    const { ink, React } = await loadInk();
    const output = ink.renderToString(
      React.createElement(ConversationPane, {
        maxRows: 4,
        width: 80,
        availableWidth: 80,
      }),
      { columns: 80 },
    );
    const rows = output.split('\n');

    expect(rows).toHaveLength(4);
    expect(output).toContain('r1/4 Running');
    expect(output).toContain('r2/4 Planned');
    expect(output).toContain('r3/4 Planned');
    expect(output).toContain('live workflow log');
    expect(output).not.toContain('r4/4 Planned');
  });

  it('keeps warning context ahead of generated files and future plans', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: [completedRound(0, 2, 0, 1)],
        outputFilesByRound: {
          0: [generatedFile('paper.tex', null)],
        },
        missingOutputsByRound: {},
        compileFailuresByRound: COMPILE_FAILURES_BY_ROUND,
      },
      3,
    );

    expect(lines.map((line) => line.text)).toEqual([
      '✓ r1/2 Finished · 0s',
      '  ✗ r1 · Compile check failed: paper.pdf · paper.log',
      '□ r2/2 Planned',
    ]);
  });
});
