import { describe, expect, it } from 'vitest';

import {
  CHILD_STATUS_MARKER,
  childFileBadgeText,
  childRowMetadataText,
  childStatusColor,
  fileDetailLines,
  pendingApprovalRowSuffix,
} from '@cli/chat/tui/panes/SubagentListDisplay';
import {
  SubagentList,
  compactChildRowText,
} from '@cli/chat/tui/panes/SubagentList';
import type { StreamSlice } from '@cli/chat/tui/state/cliState';
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
import { buildChildStreamEntries } from '@test/support/childStreamEntries';
import { loadInk } from '@test/support/inkTestHarness.mts';

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
    usage: undefined,
    cumulativeUsage: undefined,
    conversation: undefined,
    roundStage: undefined,
    entries: [],
    queuedFollowUpMessages: [],
    activeProcesses: [],
    todos: [],
    plan: null,
    processOutput: new Map(),
    bypass: { bash: false, toolEdit: false, superYolo: false },
    ...overrides,
  };
}

describe('CLI child list display model', () => {
  it('formats only populated run-file categories for badges and details', () => {
    const files = {
      input: ['src/Main.lean', 'src/Lemma.lean'],
      context: ['notes/proof.md'],
      media: [],
      output: ['Main.olean'],
    };

    expect(childFileBadgeText(files)).toBe('in:2 ctx:1 out:1');
    expect(fileDetailLines(files, 80)).toEqual([
      'Input src/Main.lean, src/Lemma.lean',
      'Context notes/proof.md',
      'Output Main.olean',
    ]);
    expect(childFileBadgeText(undefined)).toBeUndefined();
    expect(
      childFileBadgeText({ input: [], context: [], media: [], output: [] }),
    ).toBeUndefined();
    expect(fileDetailLines(files, 20)).toEqual([
      'Input src/Main.lean…',
      'Context notes/proof…',
      'Output Main.olean',
    ]);
  });

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

  it('keeps bounded process rows to the latest one-line output summary', () => {
    expect(
      compactChildRowText({
        child: {
          kind: 'process',
          executionId: 'latexmk',
          agentName: 'latex build',
          status: 'running',
          elapsed: '19sec',
        },
        nowMs: Date.now(),
        tail: {
          stdout:
            'latexmk: applying rule pdflatex\nmain.tex: Proof sketch needs one missing reference',
          stderr: '',
        },
      }),
    ).toBe(
      'latex build running · 19sec · main.tex: Proof sketch needs one missing reference',
    );
  });

  it('drops elapsed from the compact row text when the metadata column owns it', () => {
    expect(
      compactChildRowText({
        child: {
          kind: 'process',
          executionId: 'latexmk',
          agentName: 'latex build',
          status: 'running',
          elapsed: '19sec',
        },
        nowMs: Date.now(),
        omitElapsed: true,
      }),
    ).toBe('latex build running');
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

  it('omits the model from bash rows while retaining agent row details', async () => {
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
    const output: string = ink.renderToString(
      React.createElement(SubagentList, {
        listRootStreamId: run,
        maxRows: 6,
        keyboardActive: false,
        sessions,
      }),
      { columns: 100 },
    );

    expect(sessions.find(({ id }) => id === bash)?.toolName).toBe('bash');
    expect(sessions.find(({ id }) => id === agent)?.toolName).toBeUndefined();
    expect(output.match(/bash running/g)).toHaveLength(2);
    expect(output).not.toContain('gemini35f');
    expect(output).toContain('bash running · gpt56');
    expect(output).toContain('5 tool calls');
    expect(output).toContain('↓40k');
  });

  it('renders a run-file badge as the least-essential row suffix', async () => {
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

    expect(output).toContain('devise completed · in:2 ctx:1');
  });
});
