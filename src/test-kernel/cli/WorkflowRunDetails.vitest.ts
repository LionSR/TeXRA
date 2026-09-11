import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ConversationPane } from '@cli/chat/tui/panes/ConversationPane';
import { selectWorkflowRunDetailLines } from '@cli/chat/tui/panes/WorkflowRunDetails';
import { activeRunId, resetCliState } from '@cli/chat/tui/state/cliState';
import {
  AgentCategory,
  type CompileFailure,
  LOG_LEVELS,
  type OutputFileInfo,
  STREAM_LOG_ENTRY_TYPES,
  RUN_PHASE,
  type RunId,
  type TaskGroup,
} from '@shared/schemas';
import { loadInk } from '@test/support/inkTestHarness.ts';
import {
  projectTaskGroupsFromStreamLog,
  textRowFixture,
} from '@test/support/transcriptRowFixtures';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const STREAM_ID = 'workflow#details' as RunId;

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
    status: RUN_PHASE.COMPLETED,
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

beforeAll(bindTestSessionView);
afterEach(() => {
  resetCliState();
});

describe('selectWorkflowRunDetailLines', () => {
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
            data: { status: RUN_PHASE.RUNNING, kind: 'round', index: 3 },
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
            status: RUN_PHASE.COMPLETED,
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

  it('budgets detail rows together with the live transcript viewport', async () => {
    // A live (not yet settled) log row: the fold's settled prefix stays at 0.
    seedView(
      viewWith([
        makeRunView({
          id: STREAM_ID,
          category: AgentCategory.Workflow,
          status: RUN_PHASE.RUNNING,
          transcript: {
            rows: [textRowFixture('live', 'log', 'live workflow log')],
            taskGroups: [
              {
                id: 'r0',
                name: 'r0',
                kind: 'round',
                index: 0,
                total: 4,
                startTime: 0,
                status: RUN_PHASE.RUNNING,
              },
            ],
            settledRows: 0,
            run: null,
          },
        }),
      ]),
    );
    activeRunId.set(STREAM_ID);
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
});
