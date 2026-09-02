import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  pendingApprovalRowDisplay,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import { ConversationPane } from '@cli/chat/tui/panes/ConversationPane';
import {
  SubagentList,
  type SubagentListProps,
} from '@cli/chat/tui/panes/SubagentList';
import { textDisplayWidth } from '@cli/runtime/terminalText';
import {
  activeStreamId,
  emptySlice,
  streams as streamsSignal,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';
import {
  bindChildStreamState,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import {
  streamTreeViews,
  type StreamView,
} from '@cli/chat/tui/state/streamViews';
import {
  nextSelectHighlightIndex,
  selectControlledHighlightIndex,
  type SelectItem,
} from '@cli/tui/ui/Select';
import { SessionState } from '@controllers/session/SessionState';
import {
  AgentCategory,
  STREAM_PHASE,
  type ExecutionId,
  type StreamPhase,
  type StreamStage,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import type { PhaseRow } from '@shared/transcript';
import { formatWorkflowPhaseHeading } from '@shared/copy/workflowCall';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import {
  clearAllStreamStatusesForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { buildChildRosters } from '@test/support/childRosters';
import {
  fileListRowFixture,
  toolRowFixture,
  workflowPhaseGrouping,
} from '@test/support/transcriptRowFixtures';
import {
  loadInk,
  renderOutputAtTerminalSize,
} from '@test/support/inkTestHarness.ts';

function session(id: string, active = false): StreamView {
  return {
    id: id as StreamTabId,
    label: id,
    slice: undefined,
    active,
  };
}

/**
 * A workflow root as its own run emits it — see `workflowPhaseGrouping`. The
 * lifecycle phase (status machine) and cumulative usage (snapshot store) are
 * seeded on the shared substrate beside the slice, which carries neither.
 */
function workflowAgentSlice(
  id: string,
  overrides: Partial<StreamSlice> & {
    readonly status?: StreamPhase;
    readonly runStartedAt?: number;
    readonly usage?: TokenUsageStats;
  },
): StreamSlice {
  const {
    status = STREAM_PHASE.COMPLETED,
    runStartedAt,
    usage,
    ...sliceOverrides
  } = overrides;
  const streamId = id as StreamTabId;
  seedStreamStatusForTest(defaultSession().status, streamId, {
    phase: status,
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
  });
  if (usage) {
    snapshotFacts(defaultSession().snapshots).addUsage(
      streamId,
      `${id}-usage` as ExecutionId,
      usage,
    );
  }
  const grouping = workflowPhaseGrouping(sliceOverrides.entries ?? []);
  return {
    ...emptySlice(),
    ...sliceOverrides,
    entries: grouping.entries,
    ...(sliceOverrides.taskGroups ? {} : { taskGroups: grouping.taskGroups }),
  };
}

// Identity, model, stage, and tool-call counts live on the shared session
// substrate, not the CLI slice; tests seed them through the bound
// `SessionState`'s public API exactly as the fact applier does.
let sessionState: SessionState;

beforeEach(() => {
  sessionState = new SessionState(defaultSession());
  bindChildStreamState(sessionState);
});
afterEach(() => {
  unbindChildStreamState(sessionState);
  streamsSignal.set(new Map());
  clearAllStreamStatusesForTest(defaultSession().status);
});

function seedStream(
  id: StreamTabId,
  seed: {
    readonly metadata?: Parameters<SessionState['updateStreamMetadata']>[1];
    readonly stage?: StreamStage;
    readonly toolCallCount?: number;
  },
): void {
  sessionState.streamLogs.ensureStream(id);
  if (seed.metadata) sessionState.updateStreamMetadata(id, seed.metadata);
  if (seed.stage === undefined && seed.toolCallCount === undefined) return;
  sessionState.getOrCreateStreamState(id, AgentCategory.Workflow);
  sessionState.updateStreamState(id, (prev) => ({
    ...prev,
    ...(seed.stage !== undefined ? { stage: seed.stage } : {}),
    ...(seed.toolCallCount !== undefined
      ? {
          conversationProgress: {
            ...prev.conversationProgress,
            toolCallCount: seed.toolCallCount,
          },
        }
      : {}),
  }));
}

function phaseEntry(
  id: string,
  label: string,
  overrides: {
    readonly phaseIndex?: number;
    readonly phaseTotal?: number;
    readonly attemptId?: string;
  } = {},
): PhaseRow {
  return {
    id,
    kind: 'phase',
    timestamp: 0,
    level: 'info',
    heading: formatWorkflowPhaseHeading({ phaseLabel: label, ...overrides }),
    phaseLabel: label,
    ...overrides,
  };
}

async function renderSubagentList(
  props: SubagentListProps,
  columns: number,
  options: { readonly until?: (frame: string) => boolean } = {},
): Promise<string> {
  const { ink, React } = await loadInk();
  // The row renderers read lifecycle phase through `streamPhaseFor`, which
  // paints only identities the streams signal holds. Publish the fixture's
  // slices so a rendered row can reach its phase.
  const published = new Map<StreamTabId, StreamSlice>();
  for (const session of props.sessions ?? []) {
    if (!published.has(session.id)) {
      published.set(session.id, session.slice ?? emptySlice());
    }
  }
  streamsSignal.set(published);
  return renderOutputAtTerminalSize(
    ink,
    React.createElement(SubagentList, props),
    columns,
    options,
  );
}

describe('CLI child list display model', () => {
  it('prioritizes live workflow activity over metadata in a one-row viewport', async () => {
    const { ink, React } = await loadInk();
    const streamId = 'devise' as StreamTabId;
    const slice = workflowAgentSlice(streamId, {
      status: STREAM_PHASE.RUNNING,
      entries: [
        toolRowFixture('live-tool', {
          toolName: 'write_file',
          input: { path: 'paper.tex' },
          headerSummary: 'Drafting paper.tex',
          status: 'in_progress',
        }),
      ],
    });
    activeStreamId.set(streamId);
    streamsSignal.set(new Map([[streamId, slice]]));

    try {
      const output = ink.renderToString(
        React.createElement(ConversationPane, { maxRows: 1, width: 80 }),
        { columns: 80 },
      );
      expect(output).toContain('Drafting');
      expect(output).not.toContain('Input:');
    } finally {
      activeStreamId.set(undefined);
      streamsSignal.set(new Map());
    }
  });

  it.each([
    {
      activityLabel: 'live tool activity',
      activity: toolRowFixture('live-tool', {
        toolName: 'write_file',
        input: { path: 'paper.tex' },
        headerSummary: 'Drafting',
        status: 'in_progress',
      }),
      expectedActivity: 'Draf',
    },
    {
      activityLabel: 'failed tool activity',
      activity: toolRowFixture('live-error', {
        toolName: 'write_file',
        input: { path: 'paper.tex' },
        errorText: 'Failed',
        isError: true,
        headerSummary: 'Failed',
        status: 'failed',
      }),
      expectedActivity: 'Failed',
    },
  ])(
    'keeps $activityLabel visible without a static file-count row at narrow widths',
    async ({ activity, expectedActivity }) => {
      const { ink, React } = await loadInk();
      const streamId = 'devise' as StreamTabId;
      const slice = workflowAgentSlice(streamId, {
        status: STREAM_PHASE.RUNNING,
        entries: [activity],
      });
      activeStreamId.set(streamId);
      streamsSignal.set(new Map([[streamId, slice]]));

      try {
        const output: string = ink.renderToString(
          React.createElement(ConversationPane, {
            availableWidth: 18,
            maxRows: 2,
            width: 20,
          }),
          { columns: 18 },
        );
        const outputLines = output.split('\n');
        expect(outputLines.length).toBeLessThanOrEqual(2);
        expect(output).not.toContain('Input:');
        expect(output).not.toContain('Context:');
        expect(outputLines.every((line) => textDisplayWidth(line) <= 18)).toBe(
          true,
        );
        expect(output).toContain(expectedActivity);
      } finally {
        activeStreamId.set(undefined);
        streamsSignal.set(new Map());
      }
    },
  );

  it('renders held media in the live pending pane behind an unfinished tool', async () => {
    const { ink, React } = await loadInk();
    const streamId = 'media-holder' as StreamTabId;
    const slice: StreamSlice = workflowAgentSlice(streamId, {
      status: STREAM_PHASE.RUNNING,
      entries: [
        toolRowFixture('blocking-tool', {
          toolName: 'write_file',
          input: { path: 'paper.tex' },
          headerSummary: 'Drafting paper.tex',
          status: 'in_progress',
        }),
        fileListRowFixture('held-media', [
          {
            path: '/tmp/held-plot.png',
            ok: true,
            media: { kind: 'image', mimeType: 'image/png', sizeBytes: 8704 },
          },
        ]),
      ],
    });
    activeStreamId.set(streamId);
    streamsSignal.set(new Map([[streamId, slice]]));

    try {
      const output = ink.renderToString(
        React.createElement(ConversationPane, { maxRows: 4, width: 80 }),
        { columns: 80 },
      );
      expect(output).toContain('Files (1/1 loaded)');
      expect(output).toContain('✓ /tmp/held-plot.png [image, 8.5 KiB]');
    } finally {
      activeStreamId.set(undefined);
      streamsSignal.set(new Map());
    }
  });

  it('renders held workflow phases in the live pending pane behind an unfinished tool', async () => {
    const { ink, React } = await loadInk();
    const streamId = 'phase-holder' as StreamTabId;
    const slice: StreamSlice = workflowAgentSlice(streamId, {
      status: STREAM_PHASE.RUNNING,
      entries: [
        toolRowFixture('blocking-tool', {
          toolName: 'write_file',
          input: { path: 'paper.tex' },
          headerSummary: 'Drafting paper.tex',
          status: 'in_progress',
        }),
        phaseEntry('held-phase', 'Verify', {
          phaseIndex: 0,
          phaseTotal: 2,
        }),
      ],
    });
    activeStreamId.set(streamId);
    streamsSignal.set(new Map([[streamId, slice]]));

    try {
      const output = ink.renderToString(
        React.createElement(ConversationPane, { maxRows: 4, width: 80 }),
        { columns: 80 },
      );
      expect(output).toContain('◆ Verify (1/2)');
    } finally {
      activeStreamId.set(undefined);
      streamsSignal.set(new Map());
    }
  });

  it('keeps status markers steady and status colors independent of focus', () => {
    expect(CHILD_STATUS_MARKER).toBe('● ');
    expect(childStatusColor('running')).toBe('cyan');
    expect(childStatusColor('completed')).toBe('green');
    expect(childStatusColor('waiting')).toBe('yellow');
    expect(childStatusColor('failed')).toBe('red');
    expect(childStatusColor(STREAM_PHASE.CANCELLED)).toBe('gray');
    expect(childStatusColor(STREAM_PHASE.COMPLETED)).toBe('green');
  });

  it('paints an unreported or unrecognised phase neutral, never success', () => {
    // A slice exists before any status fact arrives (`emptySlice`), and a
    // future STREAM_PHASE reaches this build as an unmapped string. Neither
    // establishes success, so neither may render green.
    expect(childStatusColor(undefined)).toBe('gray');
    expect(childStatusColor('compacting')).toBe('gray');
    // Legacy free-form status strings no longer exist on the canonical rail;
    // an unmapped string is neutral, never a fabricated verdict.
    expect(childStatusColor('exit 2')).toBe('gray');
  });

  it('summarizes what a row is waiting on from its pending approval kinds', () => {
    expect(pendingApprovalRowDisplay(undefined)).toBeUndefined();
    expect(pendingApprovalRowDisplay([])).toBeUndefined();
    expect(pendingApprovalRowDisplay(['bash'])).toEqual({
      label: 'bash',
      overflow: undefined,
    });
    expect(pendingApprovalRowDisplay(['externalInquiry'])).toEqual({
      label: 'inquiry',
      overflow: undefined,
    });
    expect(
      pendingApprovalRowDisplay(['toolEdit', 'bash', 'userQuestion']),
    ).toEqual({ label: 'edit', overflow: '+2' });
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

  it('adds the tool-call count between elapsed and generated tokens', () => {
    expect(
      childRowMetadataText({
        elapsed: '2m 30s',
        outputTokens: 39_900,
        toolCallCount: 5,
      }),
    ).toBe('2m 30s · 5 tool calls · ↓40k');
    expect(
      childRowMetadataText({
        elapsed: '45s',
        outputTokens: undefined,
        toolCallCount: 1,
      }),
    ).toBe('45s · 1 tool call');
    // No tool calls yet is not a datum worth a column segment.
    expect(
      childRowMetadataText({
        elapsed: '45s',
        outputTokens: undefined,
        toolCallCount: 0,
      }),
    ).toBe('45s');
  });

  it('renders agent row metadata correctly at an explicit terminal width', async () => {
    const run = 'run' as StreamTabId;
    const bash = 'bash-1' as StreamTabId;
    const agent = 'agent-1' as StreamTabId;
    const streams = new Map<StreamTabId, StreamSlice>([
      [run, workflowAgentSlice('run', { status: STREAM_PHASE.RUNNING })],
      [bash, workflowAgentSlice('bash-1', { status: STREAM_PHASE.RUNNING })],
      [
        agent,
        workflowAgentSlice('agent-1', {
          status: STREAM_PHASE.RUNNING,
          usage: {
            inputTokens: 1000,
            outputTokens: 39_900,
            cost: 0,
          },
        }),
      ],
    ]);
    seedStream(bash, {
      metadata: {
        identity: { kind: 'process', tool: 'bash' },
        config: { model: 'gemini35f' },
      },
    });
    seedStream(agent, {
      metadata: {
        identity: { kind: 'agent', agent: 'bash' },
        config: { model: 'gpt56' },
      },
      toolCallCount: 5,
    });
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [bash, run],
      [agent, run],
    ]);
    const childRosters = buildChildRosters({
      parentStreamId: run,
      rows: [
        {
          executionId: 'bash-exec',
          agentName: 'bash',
          childStreamId: bash,
          status: STREAM_PHASE.RUNNING,
          identity: { kind: 'process', tool: 'bash' },
        },
        {
          executionId: 'agent-exec',
          // A real agent may use the same visible label. Its canonical
          // spawning tool, rather than that label, determines model display.
          agentName: 'bash',
          identity: { kind: 'agent' as const, agent: 'bash' },
          childStreamId: agent,
          status: STREAM_PHASE.RUNNING,
        },
      ],
    });
    const sessions = streamTreeViews({
      activeStreamId: run,
      childRosters,
      parentStream,
      rootStreamId: run,
      streams,
    });
    const output = await renderSubagentList(
      {
        listRootStreamId: run,
        maxRows: 6,
        keyboardActive: false,
        sessions,
      },
      100,
      { until: (frame) => frame.includes('5 tool calls') },
    );

    expect(sessions.find(({ id }) => id === bash)?.info?.identity).toEqual({
      kind: 'process',
      tool: 'bash',
    });
    expect(sessions.find(({ id }) => id === agent)?.info?.identity).toEqual({
      kind: 'agent',
      agent: 'bash',
    });
    expect(output.match(/bash running/g)).toHaveLength(2);
    expect(output).not.toContain('gemini35f');
    expect(output).toContain('bash running · GPT-5.6 Sol');
    expect(output).toContain('5 tool calls');
    expect(output).toContain('↓40k');
  });

  it('keeps run-file metadata out of the compact row', async () => {
    const run = 'run' as StreamTabId;
    const output = await renderSubagentList(
      {
        maxRows: 3,
        sessions: [
          {
            id: run,
            label: 'devise',
            active: true,
            slice: workflowAgentSlice('run', {}),
          },
        ],
      },
      100,
    );

    expect(output).toContain('devise completed');
    expect(output).not.toContain('in:2');
    expect(output).not.toContain('ctx:1');
  });

  it('uses canonical task status labels for child rows', async () => {
    const root = 'root' as StreamTabId;
    const output = await renderSubagentList(
      {
        maxRows: 5,
        sessions: [
          {
            id: 'done' as StreamTabId,
            label: 'reviewer',
            parentId: root,
            active: false,
            slice: workflowAgentSlice('done', {
              status: STREAM_PHASE.COMPLETED,
            }),
          },
          {
            id: 'failed' as StreamTabId,
            label: 'critic',
            parentId: root,
            active: false,
            slice: workflowAgentSlice('failed', {
              status: STREAM_PHASE.FAILED,
            }),
          },
          {
            id: 'waiting' as StreamTabId,
            label: 'editor',
            parentId: root,
            active: false,
            slice: workflowAgentSlice('waiting', {
              status: STREAM_PHASE.WAITING,
            }),
          },
          {
            id: 'attached' as StreamTabId,
            label: 'attached',
            parentId: root,
            active: false,
            slice: undefined,
          },
        ],
      },
      100,
    );

    expect(output).toContain('reviewer completed');
    expect(output).toContain('critic error');
    expect(output).toContain('editor idle');
    expect(output).toContain('attached');
    expect(output).not.toContain('attached —');
  });

  it.each([120, 80, 64, 56])(
    'shows a run its phase and a reflection stream its round at %i columns',
    async (columns) => {
      const run = 'run' as StreamTabId;
      const reflection = 'reflect' as StreamTabId;
      seedStream(run, {
        stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
      });
      seedStream(reflection, {
        stage: { kind: 'round', index: 1, total: 3 },
      });
      const output = await renderSubagentList(
        {
          maxRows: 4,
          sessions: [
            {
              id: run,
              label: 'workflow-script',
              active: false,
              slice: workflowAgentSlice('run', {
                status: STREAM_PHASE.RUNNING,
              }),
            },
            {
              id: reflection,
              label: 'reflect',
              active: false,
              slice: workflowAgentSlice('reflect', {
                status: STREAM_PHASE.RUNNING,
              }),
            },
          ],
        },
        columns,
        { until: (frame) => frame.includes('r2/3') },
      );

      // One line per row at every width — the phase takes the round's slot
      // rather than adding one.
      expect(
        output.split('\n').filter((line) => line.includes('Reduce (2/3)')),
      ).toHaveLength(1);
      expect(output).toContain('workflow-script running · Reduce (2/3)');
      expect(output).toContain('reflect running · r2/3');
      expect(output).not.toContain('Reduce (2/3) · r2/3');
      expect(output).not.toContain('r2/3 · Reduce (2/3)');
    },
  );

  // The right-aligned metadata column is the one row element `SubagentList`
  // drops purely on terminal width (`CHILD_ROW_METADATA_MIN_COLUMNS`), so it is
  // what proves a width test drives the width it names: through
  // `renderToString` both cases below lay out at the ambient terminal width
  // instead, and whichever side of the threshold that width falls on is the
  // only case actually exercised. Widths are spelled out rather than derived
  // from the constant so that moving the threshold has to move the test.
  it.each([
    { columns: 60, metadataColumn: true },
    { columns: 59, metadataColumn: false },
  ])(
    'renders the row metadata column at $columns columns: $metadataColumn',
    async ({ columns, metadataColumn }) => {
      const run = 'run' as StreamTabId;
      const child = 'child' as StreamTabId;
      seedStream(child, { toolCallCount: 5 });
      const output = await renderSubagentList(
        {
          listRootStreamId: run,
          maxRows: 4,
          sessions: [
            {
              id: run,
              label: 'run',
              active: false,
              slice: workflowAgentSlice('run', {
                status: STREAM_PHASE.RUNNING,
              }),
            },
            {
              id: child,
              label: 'writer',
              active: false,
              parentId: run,
              slice: workflowAgentSlice('child', {
                status: STREAM_PHASE.RUNNING,
                usage: {
                  inputTokens: 1000,
                  outputTokens: 39_900,
                  cost: 0,
                },
              }),
            },
          ],
        },
        columns,
        { until: (frame) => frame.includes('writer') },
      );

      expect(output).toContain('writer running');
      expect(output.includes('5 tool calls · ↓40k')).toBe(metadataColumn);
    },
  );
});
