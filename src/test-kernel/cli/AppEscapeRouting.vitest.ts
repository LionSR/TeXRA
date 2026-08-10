import '@test/support/defaultSessionTestSetup';

import { setTimeout as sleep } from 'node:timers/promises';

import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { App, type AppProps } from '@cli/chat/tui/App';
import { ESC_META_CHORD_INTERRUPT_DELAY_MS } from '@cli/chat/tui/appInteractionPolicy';
import { POINTER } from '@cli/tui/ui/glyphs';
import type { InputHistory } from '@cli/chat/tui/history/inputHistory';
import {
  activeStreamId,
  focusStream,
  foregroundReader,
  infoPane,
  openInfoPane,
  patchStream,
  resetCliState,
  rootRunStartAvailable,
  rootStreamId,
  setStreamStatusInCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import {
  projectChildRoster,
  setParentStream,
} from '@cli/chat/tui/state/childExecutions';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import {
  AgentCategory,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type StreamTabId,
} from '@shared/schemas';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { createRunTrace } from '@transcript';

vi.mock('@cli/runtime/shortcutLabels', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/shortcutLabels')>();
  return { ...actual, defaultShortcutModifierLabel: () => 'Esc' };
});

const ROOT = 'escape-root' as StreamTabId;
const CHILD = 'escape-child' as StreamTabId;
const GRANDCHILD = 'escape-grandchild' as StreamTabId;
const ESC = String.fromCharCode(27);

const ARROW_KEYS = {
  Up: '\u001B[A',
  Down: '\u001B[B',
  Right: '\u001B[C',
  Left: '\u001B[D',
} as const;

// Chord-window brackets derive from the production delay so a duration change
// cannot silently invalidate the within-window/expired distinction.
const WITHIN_CHORD_WINDOW_MS = Math.max(
  30,
  Math.floor(ESC_META_CHORD_INTERRUPT_DELAY_MS / 10),
);
const CHORD_WINDOW_EXPIRED_MS = ESC_META_CHORD_INTERRUPT_DELAY_MS + 100;

function setRunning(...streamIds: StreamTabId[]): void {
  for (const streamId of streamIds) {
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.RUNNING,
    });
  }
}

function markToolUseAgent(...streamIds: StreamTabId[]): void {
  for (const streamId of streamIds) {
    patchStream(streamId, (slice) => ({
      ...slice,
      identity: { kind: 'agent', agent: 'child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
    }));
  }
}

function runningChild(
  executionId: string,
  agentName: string,
  childStreamId: StreamTabId,
): Parameters<typeof projectChildRoster>[1][number] {
  return {
    executionId,
    agentName,
    identity: { kind: 'agent' as const, agent: agentName },
    childStreamId,
    status: STREAM_PHASE.RUNNING,
  };
}

function seedRootStream(): void {
  rootStreamId.set(ROOT);
  rootRunStartAvailable.set(false);
  setRunning(ROOT);
  focusStream(ROOT);
}

function seedChildHierarchy(): void {
  seedRootStream();
  setRunning(CHILD, GRANDCHILD);
  markToolUseAgent(CHILD, GRANDCHILD);
  projectChildRoster(ROOT, [
    runningChild('escape-child-execution', 'child', CHILD),
  ]);
  projectChildRoster(CHILD, [
    runningChild('escape-grandchild-execution', 'grandchild', GRANDCHILD),
  ]);
  setParentStream(CHILD, ROOT);
  setParentStream(GRANDCHILD, CHILD);
}

function finishNestedHierarchyAndFocusRoot(): void {
  for (const streamId of [GRANDCHILD, CHILD]) {
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.COMPLETED,
    });
  }
  focusStream(ROOT);
}

function appProps(
  onInterruptStream: (streamId: StreamTabId) => void,
): AppProps {
  return {
    onSubmit: vi.fn(),
    onKillExecution: vi.fn(),
    onSkipExecution: vi.fn(),
    onRetryExecution: vi.fn(),
    canInterruptActiveRun: () => true,
    canInterruptStream: () => true,
    onInterruptActive: vi.fn(),
    onInterruptStream,
  };
}

async function renderApp(props: AppProps): Promise<InkRenderHandles> {
  const { ink, React } = await loadInk();
  const handles = renderInteractive(ink, React.createElement(App, props), {
    columns: 100,
    rows: 30,
  });
  await waitFor(() => handles.stdin.listenerCount('readable') > 0);
  return handles;
}

async function renderWithInterrupt(
  extraProps: Partial<AppProps> = {},
): Promise<InkRenderHandles & { onInterruptStream: ReturnType<typeof vi.fn> }> {
  const onInterruptStream = vi.fn();
  const handles = await renderApp({
    ...appProps(onInterruptStream),
    ...extraProps,
  });
  return { ...handles, onInterruptStream };
}

function fakeHistory(entries: readonly string[]): InputHistory {
  return {
    push: async () => undefined,
    reverseFind: () => undefined,
    at: (index) => entries[index],
    length: () => entries.length,
  };
}

beforeEach(() => resetCliState());
afterEach(() => resetCliState());

describe('App foreground Escape ownership', () => {
  it('lets a foreground information pane own Escape before child back', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    openInfoPane('Reference', 'Foreground content');
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await waitFor(() => infoPane.get() === undefined);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('renders and operates a canonical workflow dashboard with zero descendants', async () => {
    seedRootStream();
    patchStream(ROOT, (slice) => ({
      ...slice,
      agent: 'solo-workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'solo-workflow',
      },
      category: AgentCategory.Workflow,
      entries: [
        {
          id: 'task-planned-only',
          role: 'workflowTask',
          text: 'Planned: Draft alone',
          finalized: false,
          task: {
            id: 'draft-alone',
            label: 'Draft alone',
            status: 'planned',
          },
        },
      ],
    }));
    const { instance, stdin, stdout, onInterruptStream } =
      await renderWithInterrupt();

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('solo-workflow · 0/1 done'));
      expect(stdout.output).toContain('Draft alone · Planned');
      stdin.write('\r');
      await sleep(30);
      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('retains projected workflow rows while child detail is focused and returns to the same task', async () => {
    seedRootStream();
    setRunning(CHILD, GRANDCHILD);
    patchStream(ROOT, (slice) => ({
      ...slice,
      agent: 'workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'workflow',
      },
      category: AgentCategory.Workflow,
    }));
    const runTrace = createRunTrace(ROOT, defaultSession().transcripts);
    const phase = runTrace.trace.openStage('Map', {
      id: 'phase-map',
      kind: 'phase',
      index: 0,
      total: 1,
    });
    for (const [logId, id, label, childStreamId] of [
      ['task-child', 'inspect', 'Inspect', CHILD],
      ['task-review', 'review', 'Review', GRANDCHILD],
    ] as const) {
      runTrace.trace.emit({
        type: 'workflow.call',
        logId,
        stageId: phase.id,
        call: {
          id,
          label,
          phase: 'Map',
          status: 'running',
          childStreamId,
        },
      });
    }
    syncStreamLog(ROOT);
    projectChildRoster(ROOT, [
      runningChild('workflow-child-execution', 'duplicate', CHILD),
      runningChild('workflow-review-execution', 'duplicate', GRANDCHILD),
    ]);
    setParentStream(CHILD, ROOT);
    setParentStream(GRANDCHILD, ROOT);
    const { instance, stdin, stdout, onInterruptStream } =
      await renderWithInterrupt();

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('workflow · 0/2 done'));
      stdin.write('\r');
      await waitFor(() => stdout.output.includes('Inspect · Running'));
      stdin.write('\r');
      await waitFor(() => activeStreamId.get() === CHILD);
      syncStreamLog(ROOT);
      expect(
        streams
          .get()
          .get(ROOT)
          ?.entries.map((entry) => [entry.id, entry.role]),
      ).toEqual([
        ['phase-map', 'phase'],
        ['task-child', 'workflowTask'],
        ['task-review', 'workflowTask'],
      ]);

      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT, {
        timeoutMs: 1_000,
      });
      const taskLine = stdout.output
        .split('\n')
        .find((line) => line.includes('Inspect · Running'));
      expect(taskLine).toContain(POINTER);
      expect(stdout.output).toContain('Esc input');

      stdin.write(ESC);
      await waitFor(() => stdout.output.includes('Tab sessions'));
      expect(activeStreamId.get()).toBe(ROOT);

      focusStream(GRANDCHILD);
      await waitFor(() => activeStreamId.get() === GRANDCHILD);
      await sleep(30);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT, {
        timeoutMs: 1_000,
      });
      await waitFor(() =>
        stdout.output
          .split('\n')
          .some(
            (line) =>
              line.includes('Review · Running') && line.includes(POINTER),
          ),
      );
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
      runTrace.dispose();
    }
  });

  it('preserves workflow selection when tasks share a child stream', async () => {
    seedRootStream();
    setRunning(CHILD);
    projectChildRoster(ROOT, [
      runningChild('shared-child-execution', 'shared-child', CHILD),
    ]);
    setParentStream(CHILD, ROOT);
    patchStream(ROOT, (slice) => ({
      ...slice,
      agent: 'ambiguous-workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'ambiguous-workflow',
      },
      category: AgentCategory.Workflow,
      entries: ['first', 'second'].map((id) => ({
        id: `task-${id}`,
        role: 'workflowTask' as const,
        text: `Running: ${id}`,
        finalized: false,
        task: {
          id,
          label: id,
          status: 'running' as const,
          childStreamId: CHILD,
        },
      })),
    }));
    const onInterruptStream = vi.fn();
    const { ink, React } = await loadInk();
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(App, appProps(onInterruptStream)),
      { columns: 100, debug: true, rows: 30 },
    );
    const currentFrame = (): string =>
      stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('\t');
      await waitFor(() =>
        currentFrame().includes('ambiguous-workflow · 0/2 done'),
      );
      stdin.write('\r');
      await waitFor(() =>
        currentFrame()
          .split('\n')
          .some(
            (line) =>
              line.includes('first · Running') && line.includes(POINTER),
          ),
      );
      stdin.write(ARROW_KEYS.Down);
      await waitFor(() =>
        currentFrame()
          .split('\n')
          .some(
            (line) =>
              line.includes('second · Running') && line.includes(POINTER),
          ),
      );

      focusStream(CHILD);
      await waitFor(() => activeStreamId.get() === CHILD);
      focusStream(ROOT);
      await waitFor(() => activeStreamId.get() === ROOT);
      await waitFor(() =>
        currentFrame()
          .split('\n')
          .some(
            (line) =>
              line.includes('second · Running') && line.includes(POINTER),
          ),
      );

      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('walks nested children back one immediate parent per bare Escape', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === CHILD);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT);

      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not apply delayed child back after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late reference');
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late reference');
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeStreamId.get() === ROOT);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('treats a second bare Escape as fresh after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write(ESC);
      await waitFor(() => onInterruptStream.mock.calls.length === 1);

      expect(onInterruptStream).toHaveBeenCalledWith(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back when the child is promoted', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      setParentStream(CHILD, null);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('treats a second Escape as fresh after topology invalidates the pending action', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      setParentStream(CHILD, null);
      stdin.write(ESC);
      await waitFor(() => onInterruptStream.mock.calls.length === 1);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).toHaveBeenCalledWith(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it('does not apply failed-chord child back after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late failed-chord reference', 'Foreground content');
      await waitFor(
        () => infoPane.get()?.title === 'Late failed-chord reference',
      );
      stdin.write('x');
      await sleep(50);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late failed-chord reference');
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it.each([
    {
      // Completed child: its input is disabled, so the printable key fails the
      // chord and must be preserved into the parent input that back enables.
      name: 'preserves a printable failed chord when back enables parent input',
      childStatus: STREAM_PHASE.COMPLETED,
    },
    {
      // Running child: its input is enabled, so the printable key must not be
      // duplicated into the parent input when back resolves.
      name: 'does not duplicate a printable failed chord from enabled input',
      childStatus: STREAM_PHASE.RUNNING,
    },
  ])('$name', async ({ childStatus }) => {
    seedChildHierarchy();
    setStreamStatusInCliState({
      streamId: CHILD,
      status: childStatus,
    });
    focusStream(CHILD);
    const onSubmit = vi.fn();
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt({
      onSubmit,
    });

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write('q');
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith('q', undefined);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it.each(Object.entries(ARROW_KEYS))(
    'resolves deferred child back before %s',
    async (_name, arrowInput) => {
      seedChildHierarchy();
      setStreamStatusInCliState({
        streamId: CHILD,
        status: STREAM_PHASE.COMPLETED,
      });
      focusStream(CHILD);
      const onSubmit = vi.fn();
      const { instance, stdin, onInterruptStream } = await renderWithInterrupt({
        onSubmit,
      });

      try {
        stdin.write(ESC);
        await sleep(WITHIN_CHORD_WINDOW_MS);
        stdin.write(arrowInput);
        await waitFor(() => activeStreamId.get() === ROOT);
        stdin.write('\r');
        await sleep(30);

        expect(onInterruptStream).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
      } finally {
        instance.unmount();
      }
    },
  );

  it('discards failed-chord child back after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write('x');
      await sleep(50);

      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards failed-chord child back when the child is promoted', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      setParentStream(CHILD, null);
      stdin.write('x');
      await sleep(50);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not resolve Esc-digit focus after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late chord reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late chord reference');
      stdin.write('1');
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late chord reference');
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('preserves two quick bare-Escape actions through the chord window', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === CHILD);
      await waitFor(() => activeStreamId.get() === ROOT);

      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('interrupts the root only once for two quick bare Escapes', async () => {
    seedChildHierarchy();
    focusStream(ROOT);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ESC);
      await waitFor(() => onInterruptStream.mock.calls.length >= 1);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).toHaveBeenCalledOnce();
      expect(onInterruptStream).toHaveBeenCalledWith(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('keeps an Esc-digit focus target after the bare-Escape window expires', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write('1');
      await waitFor(() => activeStreamId.get() === GRANDCHILD);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeStreamId.get()).toBe(GRANDCHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('collapses an incapable child composer while preserving navigation and the root draft', async () => {
    seedChildHierarchy();
    focusStream(ROOT);
    const onSubmit = vi.fn();
    const onInterruptStream = vi.fn();
    const { ink, React } = await loadInk();
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(App, {
        ...appProps(onInterruptStream),
        onSubmit,
      }),
      { columns: 100, debug: true, rows: 30 },
    );
    const currentFrame = (): string =>
      stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('preserved root draft');
      await waitFor(() => currentFrame().includes('preserved root draft'));

      patchStream(CHILD, (slice) => ({
        ...slice,
        identity: { kind: 'process', tool: 'bash' },
        // Background Bash carries this synthetic category; identity remains
        // authoritative for the composer capability.
        category: AgentCategory.ToolUse,
      }));
      focusStream(CHILD);
      await waitFor(() => activeStreamId.get() === CHILD);
      await waitFor(() => !currentFrame().includes('preserved root draft'));

      stdin.write('ignored printable submit\r');
      await sleep(30);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(currentFrame()).not.toContain('ignored printable submit');

      stdin.write('\t');
      await sleep(30);
      stdin.write('\x14');
      await sleep(30);
      expect(foregroundReader.get()).toBeUndefined();
      stdin.write('\t');
      await sleep(30);

      stdin.write('\x14');
      await waitFor(
        () =>
          foregroundReader.get()?.kind === 'transcript' &&
          foregroundReader.get()?.streamId === CHILD,
      );
      stdin.write(ESC);
      await waitFor(() => foregroundReader.get() === undefined);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT);
      await waitFor(() => currentFrame().includes('preserved root draft'));
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith('preserved root draft', undefined);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('returns hidden child composer rows to the conversation at narrow widths', async () => {
    seedChildHierarchy();
    const transcriptText = Array.from(
      { length: 20 },
      (_, index) => `layout line ${index + 1}`,
    ).join('\n');
    for (const streamId of [ROOT, CHILD]) {
      patchStream(streamId, (slice) => ({
        ...slice,
        entries: [
          {
            id: `layout-${streamId}`,
            role: 'assistant' as const,
            text: transcriptText,
            finalized: false,
          },
        ],
      }));
    }
    const { ink, React } = await loadInk();
    const { instance, stdout } = renderInteractive(
      ink,
      React.createElement(App, appProps(vi.fn())),
      { columns: 40, debug: true, rows: 12 },
    );
    const currentFrame = (): string =>
      stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');
    const visibleTranscriptRows = (): number =>
      (currentFrame().match(/layout line \d+/gu) ?? []).length;

    try {
      await waitFor(() => visibleTranscriptRows() > 0);
      const rootRows = visibleTranscriptRows();

      focusStream(CHILD);
      await waitFor(() => currentFrame().includes('Esc back'));
      const supportedChildRows = visibleTranscriptRows();
      expect(rootRows).toBe(2);
      expect(supportedChildRows).toBe(7);

      for (const fixture of [
        {
          identity: { kind: 'agent' as const, agent: 'structured-child' },
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          category: AgentCategory.ToolUse,
        },
        {
          identity: { kind: 'agent' as const, agent: 'workflow-child' },
          category: AgentCategory.Workflow,
        },
        {
          identity: { kind: 'process' as const, tool: 'bash' },
          category: AgentCategory.ToolUse,
        },
        {
          identity: {
            kind: 'agent' as const,
            agent: 'codex',
            tool: 'codex',
          },
          category: AgentCategory.ToolUse,
        },
      ]) {
        const writesBeforePatch = stdout.writes.length;
        patchStream(CHILD, (slice) => ({ ...slice, ...fixture }));
        await waitFor(
          () =>
            stdout.writes.length > writesBeforePatch &&
            visibleTranscriptRows() === 10,
        );
        expect(visibleTranscriptRows()).toBe(10);
      }
    } finally {
      instance.unmount();
    }
  });

  it('paints the choosing hint and reserves its rows for an unsupported child list', async () => {
    const viewport = { columns: 40, rows: 12 } as const;

    seedChildHierarchy();
    patchStream(CHILD, (slice) => ({
      ...slice,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    }));
    focusStream(CHILD);
    const transcriptText = Array.from(
      { length: 20 },
      (_, index) => `unsupported list line ${index + 1}`,
    ).join('\n');
    patchStream(CHILD, (slice) => ({
      ...slice,
      entries: [
        {
          id: 'unsupported-list-layout',
          role: 'assistant',
          text: transcriptText,
          finalized: false,
        },
      ],
    }));
    const { ink, React } = await loadInk();
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(App, appProps(vi.fn())),
      { ...viewport, debug: true },
    );
    const currentFrame = (): string =>
      stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');
    const visibleTranscriptRows = (): number =>
      (currentFrame().match(/unsupported list line \d+/gu) ?? []).length;

    try {
      await waitFor(() => visibleTranscriptRows() === 10);
      expect(visibleTranscriptRows()).toBe(10);
      expect(currentFrame()).not.toContain('Choosing a session');

      stdin.write('\t');
      await waitFor(
        () =>
          currentFrame().includes('Choosing a session') &&
          visibleTranscriptRows() === 4,
      );
      expect(currentFrame()).toContain('Choosing a session');
      expect(visibleTranscriptRows()).toBe(4);

      stdin.write('\t');
      await waitFor(() => visibleTranscriptRows() === 10);
      expect(visibleTranscriptRows()).toBe(10);
      expect(currentFrame()).not.toContain('Choosing a session');
    } finally {
      instance.unmount();
    }
  });

  it.each([STREAM_PHASE.RUNNING, STREAM_PHASE.WAITING])(
    'keeps the composer enabled for a %s tool-use agent child',
    async (status) => {
      seedChildHierarchy();
      setStreamStatusInCliState({ streamId: CHILD, status });
      focusStream(CHILD);
      const onSubmit = vi.fn();
      const { instance, stdin } = await renderWithInterrupt({ onSubmit });

      try {
        stdin.write('child follow-up\r');
        await waitFor(() => onSubmit.mock.calls.length === 1);
        expect(onSubmit).toHaveBeenCalledWith('child follow-up', undefined);
      } finally {
        instance.unmount();
      }
    },
  );

  it.each([
    {
      name: 'structured single-cycle workflow call',
      identity: { kind: 'agent' as const, agent: 'structured-child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.ToolUse,
    },
    {
      name: 'workflow agent',
      identity: { kind: 'agent' as const, agent: 'workflow-child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.Workflow,
    },
    {
      name: 'multi-agent workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'workflow-child',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.Workflow,
    },
    {
      name: 'background bash process',
      identity: { kind: 'process' as const, tool: 'bash' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.ToolUse,
    },
    {
      name: 'terminal-backed agent',
      identity: {
        kind: 'agent' as const,
        agent: 'codex',
        tool: 'codex',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
      category: AgentCategory.ToolUse,
    },
    {
      name: 'missing metadata',
      identity: undefined,
      userFollowUpSupport: undefined,
      category: undefined,
    },
  ])(
    'ignores printable submission for a running $name child',
    async (fixture) => {
      seedChildHierarchy();
      patchStream(CHILD, (slice) => ({
        ...slice,
        identity: fixture.identity,
        userFollowUpSupport: fixture.userFollowUpSupport,
        category: fixture.category,
      }));
      focusStream(CHILD);
      const onSubmit = vi.fn();
      const { instance, stdin, stdout } = await renderWithInterrupt({
        onSubmit,
      });

      try {
        stdin.write('must not submit\r');
        await sleep(30);
        expect(stdout.output).not.toContain('must not submit');
        expect(onSubmit).not.toHaveBeenCalled();
      } finally {
        instance.unmount();
      }
    },
  );

  it('treats list Escape as cancel and Tab as the explicit ownership transfer', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const { instance, stdin, stdout, onInterruptStream } =
      await renderWithInterrupt();

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('Choosing a session'));
      const beforeListCancel = stdout.output.length;
      stdin.write(ESC);
      await waitFor(() =>
        stdout.output.slice(beforeListCancel).includes('Esc back'),
      );

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();

      const beforeListFocus = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeListFocus).includes('Choosing a session'),
      );
      const beforeTabReturn = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeTabReturn).includes('Esc back'),
      );
    } finally {
      instance.unmount();
    }
  });

  it('does not transfer idle input arrows to an available child list', async () => {
    seedChildHierarchy();
    focusStream(ROOT);
    const { instance, stdin, stdout } = await renderWithInterrupt();

    try {
      for (const arrowInput of Object.values(ARROW_KEYS)) {
        stdin.write(arrowInput);
      }
      await sleep(30);

      expect(stdout.output).not.toContain('Choosing a session');
      expect(activeStreamId.get()).toBe(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('interrupts a promoted top-level stream because it has no back relation', async () => {
    seedChildHierarchy();
    setParentStream(CHILD, null);
    focusStream(CHILD);
    const { instance, stdin, onInterruptStream } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await waitFor(() => onInterruptStream.mock.calls.length === 1);

      expect(onInterruptStream).toHaveBeenCalledWith(CHILD);
      expect(activeStreamId.get()).toBe(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it('returns keyboard ownership to prompt history after stopping the root', async () => {
    seedRootStream();
    const onInterruptStream = vi.fn((streamId: StreamTabId) => {
      setStreamStatusInCliState({
        streamId: streamId,
        status: STREAM_PHASE.CANCELLED,
      });
      rootRunStartAvailable.set(true);
    });
    const { instance, stdin, stdout } = await renderApp({
      ...appProps(onInterruptStream),
      history: fakeHistory(['older prompt', 'latest prompt']),
    });

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ARROW_KEYS.Up);
      await waitFor(() => onInterruptStream.mock.calls.length === 1);
      await waitFor(() => stdout.output.includes('latest prompt'));
      stdin.write(ARROW_KEYS.Up);
      await waitFor(() => stdout.output.includes('older prompt'));
      stdin.write(ARROW_KEYS.Down);
      await waitFor(() => stdout.output.includes('latest prompt'));

      expect(stdout.output).not.toContain('Choosing a session');
    } finally {
      instance.unmount();
    }
  });
});
