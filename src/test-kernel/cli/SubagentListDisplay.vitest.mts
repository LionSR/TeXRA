import stripAnsi from 'strip-ansi';
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
import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import { childStreamListValue } from '@cli/chat/tui/state/childListSelection';
import {
  activeStreamId,
  streams as streamsSignal,
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
} from '@cli/chat/tui/ui/Select';
import { AgentCategory, STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { buildChildStreamEntries } from '@test/support/childStreamEntries';
import {
  loadInk,
  renderWithTerminalSize,
} from '@test/support/inkTestHarness.mts';

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
    streamId: id as StreamTabId,
    model: undefined,
    category: AgentCategory.Workflow,
    status: STREAM_PHASE.COMPLETED,
    substate: undefined,
    runStartedAt: undefined,
    description: undefined,
    thinkingActive: false,
    compactingActive: false,
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    roundStage: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    todos: [],
    plan: null,
    bypass: { bash: false, toolEdit: false, superYolo: false },
    ...overrides,
  };
}

describe('CLI child list display model', () => {
  it('shows concise input and context metadata only in an active workflow view', () => {
    const workflow = workflowAgentSlice('devise', {
      files: {
        input: ['src/Main.lean', 'src/Lemma.lean'],
        context: ['notes/proof.md'],
        media: [],
        output: ['out/Main.lean'],
      },
    });
    const toolUse = workflowAgentSlice('review', {
      category: AgentCategory.ToolUse,
      files: {
        input: ['paper.tex'],
        context: ['notes.md'],
        media: [],
        output: ['review.md'],
      },
    });
    const workflowWithoutInputs = workflowAgentSlice('empty', {
      files: { input: [], context: [], media: [], output: [] },
    });

    expect(workflowRunStatusSummary(workflow)).toBe(
      'Input: 2 files · Context: 1 file',
    );
    expect(workflowRunStatusSummary(toolUse)).toBeUndefined();
    expect(workflowRunStatusSummary(workflowWithoutInputs)).toBeUndefined();
    expect(workflowRunStatusSummary(undefined)).toBeUndefined();
  });

  it('leads the workflow status band with the current phase and its task fold', () => {
    const slice = workflowAgentSlice('itemized', {
      files: { input: ['paper.tex'], context: [], media: [], output: [] },
      entries: [
        {
          id: 'phase-map',
          role: 'phase',
          text: 'Map',
          finalized: true,
          phaseLabel: 'Map',
          phaseIndex: 0,
          phaseTotal: 3,
        },
        {
          id: 'task-a',
          role: 'workflowTask',
          text: 'Finished: Map the seams',
          finalized: true,
          task: {
            id: 'seams',
            label: 'Map the seams',
            phase: 'Map',
            status: 'completed',
            durationMs: 1_000,
          },
        },
        {
          id: 'task-b',
          role: 'workflowTask',
          text: 'Running: Read the contracts',
          finalized: false,
          task: {
            id: 'contracts',
            label: 'Read the contracts',
            phase: 'Map',
            status: 'running',
          },
        },
        {
          id: 'task-c',
          role: 'workflowTask',
          text: 'Planned: Draft the section',
          finalized: false,
          task: {
            id: 'draft',
            label: 'Draft the section',
            phase: 'Write',
            status: 'planned',
          },
        },
      ],
    });

    // Only the current phase's tasks are folded, and the phase segment leads so
    // it survives truncation on a narrow terminal.
    expect(workflowRunStatusSummary(slice)).toBe(
      'Map (1/3) · 1/2 done · Input: 1 file · Context: 0 files',
    );
  });

  it('does not invent a phase fold for phase-less tasks', () => {
    const slice = workflowAgentSlice('phase-less-only', {
      entries: [
        {
          id: 'task-loose',
          role: 'workflowTask',
          text: 'Finished: Loose task',
          finalized: true,
          task: {
            id: 'loose',
            label: 'Loose task',
            status: 'completed',
            durationMs: 1_000,
          },
        },
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
      files: { input: ['paper.tex'], context: [], media: [], output: [] },
      entries: [
        {
          id: 'phase-map',
          role: 'phase',
          text: 'Map',
          finalized: true,
          phaseLabel: 'Map',
          phaseIndex: 0,
          phaseTotal: 2,
        },
        {
          id: 'task-in-phase',
          role: 'workflowTask',
          text: 'Running: Map the seams',
          finalized: false,
          task: {
            id: 'seams',
            label: 'Map the seams',
            phase: 'Map',
            status: 'running',
          },
        },
        {
          id: 'task-loose',
          role: 'workflowTask',
          text: 'Finished: Loose task',
          finalized: true,
          task: {
            id: 'loose',
            label: 'Loose task',
            status: 'completed',
            durationMs: 1_000,
          },
        },
      ],
    });

    expect(workflowRunStatusSummary(slice)).toBe(
      'Map (1/2) · 0/1 done · Input: 1 file · Context: 0 files',
    );
  });

  it('prioritizes live workflow activity over metadata in a one-row viewport', async () => {
    const { ink, React } = await loadInk();
    const streamId = 'devise' as StreamTabId;
    const slice = workflowAgentSlice(streamId, {
      status: STREAM_PHASE.RUNNING,
      files: {
        input: ['paper.tex'],
        context: ['notes.md'],
        media: [],
        output: [],
      },
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
    'keeps $activityLabel visible below one-row long-file metadata at narrow widths',
    async ({ activity, expectedActivity }) => {
      const { ink, React } = await loadInk();
      const streamId = 'devise' as StreamTabId;
      const slice = workflowAgentSlice(streamId, {
        status: STREAM_PHASE.RUNNING,
        files: {
          input: ['inputs/a-very-long-workflow-input-filename.tex'],
          context: Array.from(
            { length: 12 },
            (_, index) => `context/a-very-long-context-filename-${index}.md`,
          ),
          media: [],
          output: [],
        },
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
        expect(outputLines).toHaveLength(2);
        expect(outputLines[0]).toBe('Input: 1 file · C…');
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
    expect(childStatusColor(undefined)).toBe('green');
    expect(childStatusColor('running')).toBe('green');
    expect(childStatusColor('waiting')).toBe('yellow');
    expect(childStatusColor('error')).toBe('red');
    expect(childStatusColor('failed')).toBe('red');
    expect(childStatusColor('exit 2')).toBe('red');
    expect(childStatusColor('stopped')).toBe('gray');
    expect(childStatusColor(STREAM_PHASE.CANCELLED)).toBe('gray');
    expect(childStatusColor(STREAM_PHASE.COMPLETED)).toBe('green');
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

  it('uses the explicit terminal width for agent row metadata', async () => {
    const { ink, React } = await loadInk();
    const run = 'run' as StreamTabId;
    const bash = 'bash-1' as StreamTabId;
    const agent = 'agent-1' as StreamTabId;
    const streams = new Map<StreamTabId, StreamSlice>([
      [run, workflowAgentSlice('run', { status: STREAM_PHASE.RUNNING })],
      [
        bash,
        workflowAgentSlice('bash-1', {
          model: 'gemini35f',
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
          kind: 'subagent',
          executionId: 'bash-exec',
          agentName: 'bash',
          childStreamId: bash,
          status: STREAM_PHASE.RUNNING,
          toolName: 'bash',
        },
        {
          kind: 'subagent',
          executionId: 'agent-exec',
          // A real agent may use the same visible label. Its canonical
          // spawning tool, rather than that label, determines model display.
          agentName: 'bash',
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
    const { instance, stdout } = renderWithTerminalSize(
      ink,
      React.createElement(SubagentList, {
        listRootStreamId: run,
        maxRows: 6,
        keyboardActive: false,
        sessions,
      }),
      100,
    );

    try {
      await waitFor(() => stdout.output.includes('5 tool calls'));
      const output = stripAnsi(stdout.output);

      expect(sessions.find(({ id }) => id === bash)?.toolName).toBe('bash');
      expect(sessions.find(({ id }) => id === agent)?.toolName).toBeUndefined();
      expect(output.match(/bash running/g)).toHaveLength(2);
      expect(output).not.toContain('gemini35f');
      expect(output).toContain('bash running · gpt56');
      expect(output).toContain('5 tool calls');
      expect(output).toContain('↓40k');
    } finally {
      instance.unmount();
    }
  });

  it('keeps run-file metadata out of the compact row', async () => {
    const { ink, React } = await loadInk();
    const run = 'run' as StreamTabId;
    const output = ink.renderToString(
      React.createElement(SubagentList, {
        maxRows: 3,
        sessions: [
          {
            id: run,
            label: 'devise',
            active: true,
            slice: workflowAgentSlice('run', {
              files: {
                input: ['Main.lean', 'Lemma.lean'],
                context: ['notes.md'],
                media: [],
                output: [],
              },
            }),
          },
        ],
      }),
      { columns: 100 },
    );

    expect(output).toContain('devise completed');
    expect(output).not.toContain('in:2');
    expect(output).not.toContain('ctx:1');
  });

  it.each([120, 80, 64, 56])(
    'shows a run its phase and a reflection stream its round at %i columns',
    async (columns) => {
      const { ink, React } = await loadInk();
      const run = 'run' as StreamTabId;
      const reflection = 'reflect' as StreamTabId;
      const output: string = ink.renderToString(
        React.createElement(SubagentList, {
          maxRows: 4,
          sessions: [
            {
              id: run,
              label: 'workflow-script',
              active: false,
              slice: workflowAgentSlice('run', {
                status: STREAM_PHASE.RUNNING,
                phaseStage: { label: 'Reduce', index: 1, total: 3 },
              }),
            },
            {
              id: reflection,
              label: 'reflect',
              active: false,
              slice: workflowAgentSlice('reflect', {
                status: STREAM_PHASE.RUNNING,
                roundStage: { index: 1, total: 3 },
              }),
            },
          ],
        }),
        { columns },
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
  // outside any `phase()`, or a roster row from before the field existed, would
  // otherwise read as belonging to the phase above it. Driven through
  // `streamTreeViews`, the one owner of row order, rather than a hand-ordered
  // `sessions` array, so it guards the production path.
  it('never renders a phase-less row beneath a phase header', async () => {
    const { ink, React } = await loadInk();
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
          kind: 'subagent',
          executionId: 'reduce-exec',
          agentName: 'reduce-agent',
          childStreamId: reduceAgent,
          status: STREAM_PHASE.RUNNING,
          workflowPhase: 'Reduce',
        },
        {
          kind: 'subagent',
          executionId: 'loose-exec',
          agentName: 'loose-agent',
          childStreamId: looseAgent,
          status: STREAM_PHASE.RUNNING,
        },
        {
          kind: 'subagent',
          executionId: 'map-exec',
          agentName: 'map-agent',
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
    const output: string = stripAnsi(
      ink.renderToString(
        React.createElement(SubagentList, {
          listRootStreamId: run,
          maxRows: 10,
          sessions,
        }),
        { columns: 100 },
      ),
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
    const { ink, React } = await loadInk();
    const run = 'nested-workflow' as StreamTabId;
    const child = 'ordinary-child' as StreamTabId;
    const output: string = ink.renderToString(
      React.createElement(SubagentList, {
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
      }),
      { columns: 100 },
    );

    expect(output).toContain('nested-workflow');
    expect(output).toContain('ordinary-child');
    expect(output).not.toContain('◆ Inherited');
  });

  it('keeps the selected stream visible when headers consume row slots', async () => {
    const { ink, React } = await loadInk();
    const run = 'windowed-run' as StreamTabId;
    const map = 'map-agent' as StreamTabId;
    const reduce = 'reduce-agent' as StreamTabId;
    const output: string = ink.renderToString(
      React.createElement(SubagentList, {
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
      }),
      { columns: 100 },
    );

    expect(output).toContain('◆ Reduce');
    expect(output).toContain('reduce-agent');
    expect(output).not.toContain('windowed-run');
    expect(output).not.toContain('map-agent');
  });

  it('switches phase progress layout at the exact width boundary', async () => {
    const { ink, React } = await loadInk();
    const run = 'run' as StreamTabId;
    const mapRetry = 'map-retry' as StreamTabId;
    const mapAttempt = 'map-attempt' as StreamTabId;
    const loose = 'loose' as StreamTabId;
    const reduce = 'reduce' as StreamTabId;
    const freeFormPhase = 'Map:review|draft';
    const sessions: StreamView[] = [
      {
        id: run,
        label: 'workflow-script',
        active: true,
        slice: workflowAgentSlice('run', {
          status: STREAM_PHASE.RUNNING,
          entries: [
            {
              id: 'phase-map',
              role: 'phase',
              text: freeFormPhase,
              finalized: true,
              phaseLabel: freeFormPhase,
              phaseIndex: 0,
              phaseTotal: 2,
            },
            {
              id: 'task-map',
              role: 'workflowTask',
              text: 'Finished: Review map',
              finalized: true,
              task: {
                id: 'review-map',
                label: 'Review map',
                phase: freeFormPhase,
                status: 'completed',
                durationMs: 1_000,
              },
            },
            {
              id: 'phase-reduce',
              role: 'phase',
              text: 'Reduce',
              finalized: true,
              phaseLabel: 'Reduce',
              phaseIndex: 1,
              phaseTotal: 2,
            },
            {
              id: 'task-reduce',
              role: 'workflowTask',
              text: 'Running: Merge map',
              finalized: false,
              task: {
                id: 'merge-map',
                label: 'Merge map',
                phase: 'Reduce',
                status: 'running',
              },
            },
          ],
        }),
      },
      // Phase-less rows head the list, as `groupWorkflowPhaseEntries` orders
      // them — never between or after groups, where the header above would
      // appear to own them.
      { ...session(loose), label: 'unphased', parentId: run },
      {
        ...session(mapRetry),
        label: 'writer-retry',
        // Retained under the run, but promoted out of its current topology,
        // so the projected view has no current parentId.
        workflowPhase: freeFormPhase,
      },
      {
        ...session(mapAttempt),
        label: 'writer-attempt',
        parentId: run,
        workflowPhase: freeFormPhase,
      },
      {
        ...session(reduce),
        label: 'editor',
        parentId: run,
        workflowPhase: 'Reduce',
      },
    ];

    async function renderAtColumns(columns: number): Promise<string> {
      const { instance, stdout } = renderWithTerminalSize(
        ink,
        React.createElement(SubagentList, {
          listRootStreamId: run,
          maxRows: 10,
          sessions,
        }),
        columns,
      );
      try {
        await waitFor(() => stdout.output.includes(freeFormPhase));
        return stripAnsi(stdout.output);
      } finally {
        instance.unmount();
      }
    }

    const wideOutput = await renderAtColumns(60);
    const narrowOutput = await renderAtColumns(59);
    const wideLines = wideOutput.split('\n');
    const wideMapHeader = wideLines.find((line) =>
      line.includes(`${freeFormPhase} (1/2)`),
    );
    const wideMapRow = wideLines.find((line) => line.includes('writer-retry'));

    expect(wideMapHeader).toBeDefined();
    expect(wideMapRow).toBeDefined();
    expect(wideMapHeader?.indexOf('◆')).toBe(wideMapRow?.indexOf('●'));
    expect(wideMapHeader?.trimEnd().endsWith('1/1')).toBe(true);
    expect(wideMapHeader).not.toContain('(1/2) · 1/1');
    expect(narrowOutput).toContain(`${freeFormPhase} (1/2) · 1/1`);
    expect(narrowOutput).toContain('Reduce (2/2) · 0/1');
    // Two attempt rows remain visible, but progress counts the one logical
    // workflow task from the transcript rather than the retry rows.
    expect(wideOutput.split(freeFormPhase)).toHaveLength(2);
    expect(wideOutput).toContain('writer-retry');
    expect(wideOutput).toContain('writer-attempt');
    expect(wideOutput.indexOf('unphased')).toBeLessThan(
      wideOutput.indexOf(`${freeFormPhase} (1/2)`),
    );
    expect(wideOutput.indexOf(`${freeFormPhase} (1/2)`)).toBeLessThan(
      wideOutput.indexOf('writer-retry'),
    );
    expect(wideOutput.indexOf('writer-retry')).toBeLessThan(
      wideOutput.indexOf('writer-attempt'),
    );
    expect(wideOutput.indexOf('writer-attempt')).toBeLessThan(
      wideOutput.indexOf('Reduce (2/2)'),
    );
  });

  it('never shows both a phase and a round on one row', async () => {
    const { ink, React } = await loadInk();
    const run = 'run' as StreamTabId;
    const output: string = ink.renderToString(
      React.createElement(SubagentList, {
        maxRows: 3,
        sessions: [
          {
            id: run,
            label: 'workflow-script',
            active: false,
            slice: workflowAgentSlice('run', {
              status: STREAM_PHASE.RUNNING,
              phaseStage: { label: 'Reduce', index: 1, total: 3 },
              roundStage: { index: 0, total: 9 },
            }),
          },
        ],
      }),
      { columns: 100 },
    );

    expect(output).toContain('Reduce 2/3');
    expect(output).not.toContain('r1/9');
  });
});
