import { afterEach, describe, expect, it } from 'vitest';

import { ConversationPane } from '@cli/chat/tui/panes/ConversationPane';
import {
  selectWorkflowRunDetailLines,
  workflowRunDetailLines,
} from '@cli/chat/tui/panes/WorkflowRunDetails';
import {
  activeStreamId,
  patchStream,
  resetCliState,
} from '@cli/chat/tui/state/cliState';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamTabId,
} from '@shared/schemas';
import { projectTaskGroupsFromStreamLog } from '@shared/streams/taskGroupProjection';
import { loadInk } from '@test/support/inkTestHarness.mts';

const STREAM_ID = 'workflow#details' as StreamTabId;

afterEach(() => {
  resetCliState();
});

describe('workflowRunDetailLines', () => {
  it('joins lifecycle, planned rounds, generated files, and warnings', () => {
    const lines = workflowRunDetailLines({
      taskGroups: [
        {
          id: 'run',
          name: 'Repository audit',
          kind: 'run',
          startTime: 1_000,
          endTime: 10_000,
          status: STREAM_PHASE.COMPLETED,
        },
        {
          id: 'r0',
          name: 'r0',
          kind: 'round',
          index: 0,
          total: 2,
          startTime: 2_000,
          endTime: 9_200,
          status: STREAM_PHASE.COMPLETED,
        },
      ],
      outputFilesByRound: {
        0: [
          {
            source: 'paper.tex',
            round: 0,
            location: {
              kind: 'workspace',
              absolutePath: '/workspace/output/paper.tex',
              relativePath: 'output/paper.tex',
            },
            lineage: null,
            diff: { added: 12, removed: 3 },
          },
        ],
      },
      missingOutputsByRound: { 0: ['appendix.tex'] },
      compileFailuresByRound: {
        0: [
          {
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
          },
        ],
      },
    });

    expect(lines.map((line) => line.text)).toEqual([
      '✓ Repository audit completed · 9s',
      '✓ r0 (1/2) completed · 7s',
      '  Generated files',
      '    › output/paper.tex (+12 -3)',
      '  ⚠ r0 · Missing expected output: appendix.tex',
      '  ✗ r0 · Compile check failed: paper.pdf · paper.log',
      '□ r1 (2/2) planned',
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

  it('renders a normalized rN round and sanitizes terminal controls', () => {
    const lines = workflowRunDetailLines({
      taskGroups: projectTaskGroupsFromStreamLog([
        {
          seqNo: 1,
          id: 'legacy-r3',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
          level: LOG_LEVELS.INFO,
          timestamp: 0,
          text: 'r3',
          data: { status: STREAM_PHASE.RUNNING },
        },
      ]),
      outputFilesByRound: {},
      missingOutputsByRound: { 3: ['bad\u001b[31m.tex'] },
      compileFailuresByRound: {},
    });

    expect(lines.map((line) => line.text)).toEqual([
      '● r3 running',
      '  ⚠ r3 · Missing expected output: bad.tex',
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
        compileFailuresByRound: {
          0: [
            {
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
            },
          ],
        },
      },
      1,
    );

    expect(line?.text).toBe(
      '  ✗ r0 · Compile check failed: paper.pdf · paper.log',
    );
    expect(line?.role).toBe('alert');
  });

  it.each([
    ['unclassified', undefined],
    ['round without an index', 'round'],
    ['session stage', 'session'],
  ] as const)('keeps a %s lifecycle group visible', (_case, kind) => {
    const lines = workflowRunDetailLines({
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
    });

    expect(lines.map((line) => line.text)).toEqual([
      '✓ Round 3 completed · 1s',
    ]);
  });

  it('budgets detail rows together with the live transcript viewport', async () => {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      category: AgentCategory.Workflow,
      status: STREAM_PHASE.RUNNING,
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
      entries: [
        {
          id: 'live',
          role: 'assistant',
          text: 'live workflow log',
          messageType: MESSAGE_TYPES.DEFAULT,
          finalized: false,
        },
      ],
    }));
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
    expect(output).toContain('r0 (1/4) running');
    expect(output).toContain('r1 (2/4) planned');
    expect(output).toContain('r2 (3/4) planned');
    expect(output).toContain('live workflow log');
    expect(output).not.toContain('r3 (4/4) planned');
  });

  it('keeps warning context ahead of generated files and future plans', () => {
    const lines = selectWorkflowRunDetailLines(
      {
        taskGroups: [
          {
            id: 'r0',
            name: 'r0',
            kind: 'round',
            index: 0,
            total: 2,
            startTime: 0,
            endTime: 1,
            status: STREAM_PHASE.COMPLETED,
          },
        ],
        outputFilesByRound: {
          0: [
            {
              source: 'paper.tex',
              round: 0,
              location: {
                kind: 'workspace',
                absolutePath: '/workspace/paper.tex',
                relativePath: 'paper.tex',
              },
              lineage: null,
              diff: null,
            },
          ],
        },
        missingOutputsByRound: {},
        compileFailuresByRound: {
          0: [
            {
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
            },
          ],
        },
      },
      3,
    );

    expect(lines.map((line) => line.text)).toEqual([
      '✓ r0 (1/2) completed · 1s',
      '  ✗ r0 · Compile check failed: paper.pdf · paper.log',
      '□ r1 (2/2) planned',
    ]);
  });
});
