import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childRowMetadataText,
  childStatusColor,
  pendingApprovalRowSuffix,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  ConversationPane,
  workflowRunStatusSummary,
} from '@cli/chat/tui/panes/ConversationPane';
import {
  SubagentList,
  workflowDashboardPanelItemCount,
  type SubagentListProps,
} from '@cli/chat/tui/panes/SubagentList';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import {
  childStreamListValue,
  workflowPhaseListValue,
  workflowTaskListValue,
} from '@cli/chat/tui/state/childListSelection';
import {
  activeStreamId,
  emptySlice,
  streams as streamsSignal,
  type ConversationEntry,
  type StreamSlice,
} from '@cli/chat/tui/state/cliState';
import {
  streamTreeViews,
  type StreamView,
} from '@cli/chat/tui/state/streamViews';
import {
  nextSelectHighlightIndex,
  selectControlledHighlightIndex,
  visibleSelectRange,
  type SelectItem,
} from '@cli/tui/ui/Select';
import {
  AgentCategory,
  STREAM_PHASE,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { buildChildStreamEntries } from '@test/support/childStreamEntries';
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

function workflowAgentSlice(
  id: string,
  overrides: Partial<StreamSlice>,
): StreamSlice {
  return {
    ...emptySlice(id as StreamTabId),
    category: AgentCategory.Workflow,
    status: STREAM_PHASE.COMPLETED,
    ...overrides,
  };
}

function files(
  input: string[],
  context: string[] = [],
  output: string[] = [],
): NonNullable<StreamSlice['files']> {
  return { input, context, media: [], output };
}

function phaseEntry(
  id: string,
  label: string,
  overrides: {
    readonly finalized?: boolean;
    readonly phaseIndex?: number;
    readonly phaseTotal?: number;
  } = {},
): ConversationEntry {
  return {
    id,
    role: 'phase',
    text: label,
    finalized: true,
    phaseLabel: label,
    ...overrides,
  };
}

function workflowTaskEntry(
  id: string,
  text: string,
  task: WorkflowCallProgress,
  finalized = false,
): ConversationEntry {
  return { id, role: 'workflowTask', text, finalized, task };
}

async function renderSubagentList(
  props: SubagentListProps,
  columns: number,
  options: { readonly until?: (frame: string) => boolean } = {},
): Promise<string> {
  const { ink, React } = await loadInk();
  return renderOutputAtTerminalSize(
    ink,
    React.createElement(SubagentList, props),
    columns,
    options,
  );
}

describe('CLI child list display model', () => {
  it('budgets a wide dashboard from the selected phase rather than all tasks', () => {
    const tasks = [
      ['a-1', 'A'],
      ['a-2', 'A'],
      ['b-1', 'B'],
      ['b-2', 'B'],
      ['b-3', 'B'],
      ['b-4', 'B'],
      ['b-5', 'B'],
    ].map(([id, phase]) =>
      workflowTaskEntry(`task-${id}`, `Planned: ${id}`, {
        id,
        label: id,
        phase,
        status: 'planned',
      }),
    );
    const root = workflowAgentSlice('budget-root', {
      entries: [
        phaseEntry('phase-a', 'A', { finalized: false }),
        ...tasks.slice(0, 2),
        phaseEntry('phase-b', 'B', { finalized: false }),
        ...tasks.slice(2),
      ],
    });

    expect(
      workflowDashboardPanelItemCount(
        root,
        workflowPhaseListValue('phase-a'),
        100,
      ),
    ).toBe(3);
    expect(
      workflowDashboardPanelItemCount(
        root,
        workflowTaskListValue('task-b-1'),
        100,
      ),
    ).toBe(6);
    expect(
      workflowDashboardPanelItemCount(
        root,
        workflowPhaseListValue('phase-a'),
        99,
      ),
    ).toBe(10);
  });

  it('omits static input and context counts from the live workflow band', () => {
    const workflow = workflowAgentSlice('devise', {
      files: files(
        ['src/Main.lean', 'src/Lemma.lean'],
        ['notes/proof.md'],
        ['out/Main.lean'],
      ),
    });
    const toolUse = workflowAgentSlice('review', {
      category: AgentCategory.ToolUse,
      files: files(['paper.tex'], ['notes.md'], ['review.md']),
    });
    const workflowWithoutInputs = workflowAgentSlice('empty', {
      files: files([]),
    });

    expect(workflowRunStatusSummary(workflow)).toBeUndefined();
    expect(workflowRunStatusSummary(toolUse)).toBeUndefined();
    expect(workflowRunStatusSummary(workflowWithoutInputs)).toBeUndefined();
    expect(workflowRunStatusSummary(undefined)).toBeUndefined();
  });

  it('leads the workflow status band with the current phase and its task fold', () => {
    const slice = workflowAgentSlice('itemized', {
      files: files(['paper.tex']),
      entries: [
        phaseEntry('phase-map', 'Map', { phaseIndex: 0, phaseTotal: 3 }),
        workflowTaskEntry(
          'task-a',
          'Finished: Map the seams',
          {
            id: 'seams',
            label: 'Map the seams',
            phase: 'Map',
            status: 'completed',
            durationMs: 1_000,
          },
          true,
        ),
        workflowTaskEntry('task-b', 'Running: Read the contracts', {
          id: 'contracts',
          label: 'Read the contracts',
          phase: 'Map',
          status: 'running',
        }),
        workflowTaskEntry('task-c', 'Planned: Draft the section', {
          id: 'draft',
          label: 'Draft the section',
          phase: 'Write',
          status: 'planned',
        }),
      ],
    });

    // Only the current phase's tasks are folded, and the phase segment leads so
    // it survives truncation on a narrow terminal.
    expect(workflowRunStatusSummary(slice)).toBe('Map (1/3) · 1/2 done');
  });

  it('does not invent a phase fold for phase-less tasks', () => {
    const slice = workflowAgentSlice('phase-less-only', {
      entries: [
        workflowTaskEntry(
          'task-loose',
          'Finished: Loose task',
          {
            id: 'loose',
            label: 'Loose task',
            status: 'completed',
            durationMs: 1_000,
          },
          true,
        ),
      ],
    });

    expect(workflowRunStatusSummary(slice)).toBeUndefined();
  });

  it('leaves a phase-less task out of the active phase fold', () => {
    // A declared task may carry no phase even while a phase is running. Its
    // card is grouped at the run stage rather than in the phase, so the phase
    // fold must not count it either — the bridge records the task's phase once
    // and stamps both, so the count here can never name a phase the card is
    // not in.
    const slice = workflowAgentSlice('loose', {
      files: files(['paper.tex']),
      entries: [
        phaseEntry('phase-map', 'Map', { phaseIndex: 0, phaseTotal: 2 }),
        workflowTaskEntry('task-in-phase', 'Running: Map the seams', {
          id: 'seams',
          label: 'Map the seams',
          phase: 'Map',
          status: 'running',
        }),
        workflowTaskEntry(
          'task-loose',
          'Finished: Loose task',
          {
            id: 'loose',
            label: 'Loose task',
            status: 'completed',
            durationMs: 1_000,
          },
          true,
        ),
      ],
    });

    expect(workflowRunStatusSummary(slice)).toBe('Map (1/2) · 0/1 done');
  });

  it('prioritizes live workflow activity over metadata in a one-row viewport', async () => {
    const { ink, React } = await loadInk();
    const streamId = 'devise' as StreamTabId;
    const slice = workflowAgentSlice(streamId, {
      status: STREAM_PHASE.RUNNING,
      files: files(['paper.tex'], ['notes.md']),
      entries: [
        {
          id: 'live-tool',
          role: 'tool',
          text: '',
          finalized: false,
          toolUse: {
            toolName: 'write_file',
            errorText: '',
            outputText: '',
            userInstructionText: '',
            input: { path: 'paper.tex' },
            isError: false,
            isUserFeedback: false,
            headerSummary: 'Drafting paper.tex',
            status: 'in_progress',
          },
        },
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
      activity: {
        id: 'live-tool',
        role: 'tool' as const,
        text: '',
        finalized: false,
        toolUse: {
          toolName: 'write_file',
          errorText: '',
          outputText: '',
          userInstructionText: '',
          input: { path: 'paper.tex' },
          isError: false,
          isUserFeedback: false,
          headerSummary: 'Drafting',
          status: 'in_progress' as const,
        },
      },
      expectedActivity: 'Draf',
    },
    {
      activityLabel: 'failed tool activity',
      activity: {
        id: 'live-error',
        role: 'tool' as const,
        text: '',
        finalized: false,
        toolUse: {
          toolName: 'write_file',
          errorText: 'Failed',
          outputText: '',
          userInstructionText: '',
          input: { path: 'paper.tex' },
          isError: true,
          isUserFeedback: false,
          headerSummary: 'Failed',
          status: 'failed' as const,
        },
      },
      expectedActivity: 'Failed',
    },
  ])(
    'keeps $activityLabel visible without a static file-count row at narrow widths',
    async ({ activity, expectedActivity }) => {
      const { ink, React } = await loadInk();
      const streamId = 'devise' as StreamTabId;
      const slice = workflowAgentSlice(streamId, {
        status: STREAM_PHASE.RUNNING,
        files: files(
          ['inputs/a-very-long-workflow-input-filename.tex'],
          Array.from(
            { length: 12 },
            (_, index) => `context/a-very-long-context-filename-${index}.md`,
          ),
        ),
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
    expect(pendingApprovalRowSuffix(undefined)).toBeUndefined();
    expect(pendingApprovalRowSuffix([])).toBeUndefined();
    expect(pendingApprovalRowSuffix(['bash'])).toBe('bash');
    expect(pendingApprovalRowSuffix(['externalInquiry'])).toBe('inquiry');
    expect(pendingApprovalRowSuffix(['toolEdit', 'bash', 'userQuestion'])).toBe(
      'edit +2',
    );
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

  it('keeps a non-first selected row visible after the row budget shrinks', () => {
    const sessions = [
      session('main', true),
      session('strategy'),
      session('lean'),
      session('review'),
    ];
    const selected = sessions[2]?.id;
    const selectedIndex = sessions.findIndex(({ id }) => id === selected);

    expect(
      visibleSelectRange({
        highlight: selectedIndex,
        itemCount: sessions.length,
        maxVisibleItems: 2,
      }),
    ).toEqual({ start: 1, end: 3 });
    expect(
      visibleSelectRange({
        highlight: selectedIndex,
        itemCount: sessions.length,
        maxVisibleItems: 1,
      }),
    ).toEqual({ start: 2, end: 3 });
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
      [
        bash,
        workflowAgentSlice('bash-1', {
          model: 'gemini35f',
          identity: { kind: 'process', tool: 'bash' },
          status: STREAM_PHASE.RUNNING,
        }),
      ],
      [
        agent,
        workflowAgentSlice('agent-1', {
          model: 'gpt56',
          status: STREAM_PHASE.RUNNING,
          conversation: { toolCallCount: 5 },
          cumulativeUsage: {
            inputTokens: 1000,
            outputTokens: 39_900,
            cost: 0,
          },
        }),
      ],
    ]);
    const parentStream = new Map<StreamTabId, StreamTabId>([
      [bash, run],
      [agent, run],
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: run,
      retained: [
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
      childStreamEntries,
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

    expect(sessions.find(({ id }) => id === bash)?.identity).toEqual({
      kind: 'process',
      tool: 'bash',
    });
    expect(sessions.find(({ id }) => id === agent)?.identity).toEqual({
      kind: 'agent',
      agent: 'bash',
    });
    expect(output.match(/bash running/g)).toHaveLength(2);
    expect(output).not.toContain('gemini35f');
    expect(output).toContain('bash running · gpt56');
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
            slice: workflowAgentSlice('run', {
              files: files(['Main.lean', 'Lemma.lean'], ['notes.md']),
            }),
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
                stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
              }),
            },
            {
              id: reflection,
              label: 'reflect',
              active: false,
              slice: workflowAgentSlice('reflect', {
                status: STREAM_PHASE.RUNNING,
                stage: { kind: 'round', index: 1, total: 3 },
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
        output.split('\n').filter((line) => line.includes('Reduce 2/3')),
      ).toHaveLength(1);
      expect(output).toContain('workflow-script running · Reduce 2/3');
      expect(output).toContain('reflect running · r2/3');
      expect(output).not.toContain('Reduce 2/3 · r2/3');
      expect(output).not.toContain('r2/3 · Reduce 2/3');
    },
  );

  // A `◆ {phase}` header opens a group and nothing closes one, so a row that
  // carries no phase must never be painted after one — an `agent()` call issued
  // outside any `phase()` would otherwise read as belonging to the phase above
  // it. Driven through
  // `streamTreeViews`, the one owner of row order, rather than a hand-ordered
  // `sessions` array, so it guards the production path.
  it('never renders a phase-less row beneath a phase header', async () => {
    const run = 'run' as StreamTabId;
    const mapAgent = 'map-agent' as StreamTabId;
    const looseAgent = 'loose-agent' as StreamTabId;
    const reduceAgent = 'reduce-agent' as StreamTabId;
    const children = [reduceAgent, looseAgent, mapAgent];
    const streams = new Map<StreamTabId, StreamSlice>([
      [run, workflowAgentSlice('run', { status: STREAM_PHASE.RUNNING })],
      ...children.map(
        (id) =>
          [
            id,
            workflowAgentSlice(id, { status: STREAM_PHASE.RUNNING }),
          ] as const,
      ),
    ]);
    const childStreamEntries = buildChildStreamEntries({
      parentStreamId: run,
      // Oldest first, as the roster retains them; the list reverses to
      // newest-first, which is what interleaves `loose` between the groups.
      retained: [
        {
          executionId: 'reduce-exec',
          agentName: 'reduce-agent',
          identity: { kind: 'agent' as const, agent: 'reduce-agent' },
          childStreamId: reduceAgent,
          status: STREAM_PHASE.RUNNING,
          workflowPhase: 'Reduce',
        },
        {
          executionId: 'loose-exec',
          agentName: 'loose-agent',
          identity: { kind: 'agent' as const, agent: 'loose-agent' },
          childStreamId: looseAgent,
          status: STREAM_PHASE.RUNNING,
        },
        {
          executionId: 'map-exec',
          agentName: 'map-agent',
          identity: { kind: 'agent' as const, agent: 'map-agent' },
          childStreamId: mapAgent,
          status: STREAM_PHASE.RUNNING,
          workflowPhase: 'Map',
        },
      ],
    });
    const sessions = streamTreeViews({
      activeStreamId: run,
      childStreamEntries,
      parentStream: new Map(children.map((id) => [id, run] as const)),
      rootStreamId: run,
      streams,
    });
    const output = await renderSubagentList(
      {
        listRootStreamId: run,
        maxRows: 10,
        sessions,
      },
      100,
      { until: (frame) => frame.includes('◆ Reduce') },
    );

    expect(output).toContain('◆ Map');
    expect(output).toContain('◆ Reduce');
    expect(output).toContain('loose-agent running');
    // The phase-less row sits above every header, so no header can be read as
    // owning it.
    expect(output.indexOf('loose-agent running')).toBeLessThan(
      output.indexOf('◆'),
    );
    // One header per phase, and each group's rows still follow its own header.
    expect(output.split('◆ Map')).toHaveLength(2);
    expect(output.split('◆ Reduce')).toHaveLength(2);
    expect(output.indexOf('◆ Map')).toBeLessThan(
      output.indexOf('map-agent running'),
    );
    expect(output.indexOf('map-agent running')).toBeLessThan(
      output.indexOf('◆ Reduce'),
    );
    expect(output.indexOf('◆ Reduce')).toBeLessThan(
      output.indexOf('reduce-agent running'),
    );
  });

  it('does not group a list root by its inherited workflow phase', async () => {
    const run = 'nested-workflow' as StreamTabId;
    const child = 'ordinary-child' as StreamTabId;
    const output = await renderSubagentList(
      {
        listRootStreamId: run,
        maxRows: 5,
        sessions: [
          {
            id: run,
            label: 'nested-workflow',
            active: true,
            workflowPhase: 'Inherited',
            slice: workflowAgentSlice(run, {}),
          },
          { ...session(child), parentId: run },
        ],
      },
      100,
      { until: (frame) => frame.includes('ordinary-child') },
    );

    expect(output).toContain('nested-workflow');
    expect(output).toContain('ordinary-child');
    expect(output).not.toContain('◆ Inherited');
  });

  it('keeps the selected stream visible when headers consume row slots', async () => {
    const run = 'windowed-run' as StreamTabId;
    const map = 'map-agent' as StreamTabId;
    const reduce = 'reduce-agent' as StreamTabId;
    const output = await renderSubagentList(
      {
        listRootStreamId: run,
        maxRows: 3,
        selectedValue: childStreamListValue(reduce),
        sessions: [
          {
            id: run,
            label: 'windowed-run',
            active: false,
            slice: workflowAgentSlice(run, {}),
          },
          {
            ...session(map),
            parentId: run,
            workflowPhase: 'Map',
          },
          {
            ...session(reduce, true),
            parentId: run,
            workflowPhase: 'Reduce',
          },
        ],
      },
      100,
      { until: (frame) => frame.includes('reduce-agent') },
    );

    expect(output).toContain('◆ Reduce');
    expect(output).toContain('reduce-agent');
    expect(output).not.toContain('windowed-run');
    expect(output).not.toContain('map-agent');
  });

  it('renders canonical workflow calls and switches panes at the exact boundary', async () => {
    const run = 'run' as StreamTabId;
    const exactChild = 'exact-child' as StreamTabId;
    const wrongChild = 'wrong-child' as StreamTabId;
    const rootSlice = workflowAgentSlice(run, {
      agent: 'research-workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'research-workflow',
      },
      status: STREAM_PHASE.RUNNING,
      entries: [
        phaseEntry('phase-map', 'Map', { phaseIndex: 0, phaseTotal: 2 }),
        workflowTaskEntry('task-planned', 'Planned: Duplicate', {
          id: 'planned',
          label: 'Duplicate',
          phase: 'Map',
          status: 'planned',
        }),
        workflowTaskEntry('task-running', 'Running: Duplicate', {
          id: 'running',
          label: 'Duplicate',
          phase: 'Map',
          status: 'running',
          childStreamId: exactChild,
        }),
        phaseEntry('phase-write', 'Write', { phaseIndex: 1, phaseTotal: 2 }),
        workflowTaskEntry(
          'task-finished',
          'Finished: Duplicate',
          {
            id: 'finished',
            label: 'Duplicate',
            phase: 'Write',
            status: 'completed',
            childStreamId: wrongChild,
            model: 'terminal-model',
            durationMs: 2_000,
            totalCostUsd: 0.125,
          },
          true,
        ),
        workflowTaskEntry(
          'task-cached',
          'Saved result: Cached without child',
          {
            id: 'cached',
            label: 'Cached without child',
            phase: 'Write',
            status: 'cached',
          },
          true,
        ),
      ],
    });
    const streams = new Map<StreamTabId, StreamSlice>([
      [run, rootSlice],
      [
        exactChild,
        workflowAgentSlice(exactChild, {
          model: 'exact-live-model',
          runStartedAt: Date.now() - 5_000,
          cumulativeUsage: {
            inputTokens: 100,
            outputTokens: 512,
            cost: 0.004,
          },
        }),
      ],
      [
        wrongChild,
        workflowAgentSlice(wrongChild, {
          model: 'wrong-child-model',
          cumulativeUsage: {
            inputTokens: 100,
            outputTokens: 999,
            cost: 9,
          },
        }),
      ],
    ]);
    const sessions: StreamView[] = [
      { id: run, label: 'workflow-script', active: true, slice: rootSlice },
      { ...session(exactChild), label: 'Duplicate', parentId: run },
      { ...session(wrongChild), label: 'Duplicate', parentId: run },
    ];

    async function renderAtColumns(columns: number): Promise<string> {
      return renderSubagentList(
        {
          listRootStreamId: run,
          listRootSlice: rootSlice,
          maxRows: 10,
          selectedValue: workflowPhaseListValue('phase-map'),
          sessions,
          streams,
        },
        columns,
        { until: (frame) => frame.includes('research-workflow') },
      );
    }

    const wideOutput = await renderAtColumns(100);
    const narrowOutput = await renderAtColumns(99);

    expect(wideOutput).toContain('research-workflow · 2/4 done');
    expect(wideOutput).toContain('Map (1/2) · 0/2');
    expect(wideOutput).toContain('Duplicate · Planned');
    expect(wideOutput).toContain('Duplicate · Running');
    expect(wideOutput).toContain('exact-live-model');
    expect(wideOutput).toContain('5s');
    expect(wideOutput).toContain('↓512');
    expect(wideOutput).toContain('$0.004');
    expect(wideOutput).not.toContain('terminal-model');
    expect(wideOutput).not.toContain('wrong-child-model');
    expect(wideOutput).not.toContain('↓999');

    expect(narrowOutput.indexOf('Map (1/2)')).toBeLessThan(
      narrowOutput.indexOf('Duplicate · Planned'),
    );
    expect(narrowOutput.indexOf('Duplicate · Running')).toBeLessThan(
      narrowOutput.indexOf('Write (2/2)'),
    );
    expect(narrowOutput).toContain('terminal-model');
    expect(narrowOutput).toContain('2s');
    expect(narrowOutput).toContain('↓999');
    expect(narrowOutput).toContain('$0.125');
    expect(narrowOutput).toContain('Cached without child · Saved result');
    for (const [output, columns] of [
      [wideOutput, 100],
      [narrowOutput, 99],
    ] as const) {
      expect(output.split('\n')).toHaveLength(10);
      expect(
        output.split('\n').every((line) => textDisplayWidth(line) <= columns),
      ).toBe(true);
    }
  });

  it('collapses phase labels, synthesizes missing groups, and rejects ambiguous child facts', async () => {
    const run = 'grouped-run' as StreamTabId;
    const shared = 'shared-child' as StreamTabId;
    const fallback = 'fallback-child' as StreamTabId;
    const missing = 'missing-child' as StreamTabId;
    const rootSlice = workflowAgentSlice(run, {
      agent: 'grouped-workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'grouped-workflow',
      },
      status: STREAM_PHASE.RUNNING,
      entries: [
        phaseEntry('phase-map-a', 'Map', { phaseIndex: 0, phaseTotal: 2 }),
        phaseEntry('phase-map-b', 'Map'),
        workflowTaskEntry('task-map', 'Planned: Audit', {
          id: 'audit',
          label: 'Audit',
          phase: 'Map',
          status: 'planned',
        }),
        workflowTaskEntry('task-orphan', 'Planned: Synthesize', {
          id: 'synthesize',
          label: 'Synthesize',
          phase: 'Synthesis',
          status: 'planned',
        }),
        workflowTaskEntry('task-loose', 'Planned: Loose', {
          id: 'loose',
          label: 'Loose',
          status: 'planned',
        }),
        ...['first', 'second'].map((id) =>
          workflowTaskEntry(`task-reused-${id}`, `Running: Reused ${id}`, {
            id: `reused-${id}`,
            label: `Reused ${id}`,
            status: 'running',
            childStreamId: shared,
          }),
        ),
        workflowTaskEntry(
          'task-reused-terminal',
          'Finished: Reused terminal',
          {
            id: 'reused-terminal',
            label: 'Reused terminal',
            status: 'completed',
            childStreamId: shared,
            model: 'call-owned-model',
            durationMs: 1_000,
            totalCostUsd: 0.5,
          },
          true,
        ),
        workflowTaskEntry('task-missing', 'Running: Missing', {
          id: 'missing',
          label: 'Missing',
          status: 'running',
          childStreamId: missing,
        }),
        workflowTaskEntry(
          'task-fallback',
          'Finished: Fallback',
          {
            id: 'fallback',
            label: 'Fallback',
            status: 'completed',
            childStreamId: fallback,
          },
          true,
        ),
      ],
    });
    const streams = new Map<StreamTabId, StreamSlice>([
      [run, rootSlice],
      [
        shared,
        workflowAgentSlice(shared, {
          model: 'ambiguous-model',
          cumulativeUsage: {
            inputTokens: 100,
            outputTokens: 999,
            cost: 9,
          },
        }),
      ],
      [
        fallback,
        workflowAgentSlice(fallback, {
          model: 'fallback-model',
          runStartedAt: Date.now() - 5_000,
          cumulativeUsage: {
            inputTokens: 100,
            outputTokens: 321,
            cost: 0.007,
          },
        }),
      ],
    ]);
    const props: SubagentListProps = {
      listRootStreamId: run,
      listRootSlice: rootSlice,
      maxRows: 15,
      sessions: [],
      streams,
    };
    const wideOutput = await renderSubagentList(
      {
        ...props,
        selectedValue: workflowPhaseListValue('task-orphan'),
      },
      100,
      { until: (frame) => frame.includes('Synthesize · Planned') },
    );
    const narrowOutput = await renderSubagentList(
      {
        ...props,
        selectedValue: workflowTaskListValue('task-fallback'),
      },
      99,
      { until: (frame) => frame.includes('Fallback · Finished') },
    );

    expect(wideOutput.match(/Map \(1\/2\) · 0\/1/g)).toHaveLength(1);
    expect(wideOutput).toContain('Synthesis · 0/1');
    expect(wideOutput).toContain('Unphased · 2/6');
    expect(wideOutput).toContain('Synthesize · Planned');
    expect(narrowOutput.match(/Map \(1\/2\) · 0\/1/g)).toHaveLength(1);
    expect(narrowOutput).toContain('Synthesis · 0/1');
    expect(narrowOutput).toContain('Unphased · 2/6');
    expect(narrowOutput).toContain('Loose · Planned');

    const reusedLine = narrowOutput
      .split('\n')
      .find((line) => line.includes('Reused first · Running'));
    expect(reusedLine).not.toContain('ambiguous-model');
    expect(reusedLine).not.toContain('↓999');
    const reusedTerminalLine = narrowOutput
      .split('\n')
      .find((line) => line.includes('Reused terminal · Finished'));
    expect(reusedTerminalLine).toContain('call-owned-model');
    expect(reusedTerminalLine).toContain('1s');
    expect(reusedTerminalLine).toContain('$0.500');
    expect(reusedTerminalLine).not.toContain('ambiguous-model');
    expect(reusedTerminalLine).not.toContain('↓999');
    const missingLine = narrowOutput
      .split('\n')
      .find((line) => line.includes('Missing · Running'));
    expect(missingLine).toBeDefined();
    expect(missingLine).not.toContain('fallback-model');
    const fallbackLine = narrowOutput
      .split('\n')
      .find((line) => line.includes('Fallback · Finished'));
    expect(fallbackLine).toContain('fallback-model');
    expect(fallbackLine).toContain('↓321');
    expect(fallbackLine).toContain('$0.007');
    expect(fallbackLine).not.toContain('5s');
  });

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
                conversation: { toolCallCount: 5 },
                cumulativeUsage: {
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
