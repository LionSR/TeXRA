import '@test/support/defaultSessionTestSetup';

import { setTimeout as sleep } from 'node:timers/promises';

import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { App, type AppProps } from '@cli/chat/tui/App';
import { ESC_META_CHORD_INTERRUPT_DELAY_MS } from '@cli/chat/tui/appInteractionPolicy';
import {
  clearApprovals,
  currentApproval,
  enqueueApproval,
} from '@cli/chat/tui/state/approvalQueue';
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
  bindChildStreamState,
  invalidateChildStreams,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { SessionState } from '@controllers/session/SessionState';
import {
  AgentCategory,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type ActiveChildInfo,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import type { TranscriptRowOf } from '@shared/transcript';
import { textRowFixture } from '@test/support/transcriptRowFixtures';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { createRunTrace } from '@transcript';
import type { StreamSummaryMeta } from '@transcript/StreamLogStore';

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

// The status machine stamps a run window on every RUNNING transition and the
// slice mirrors it verbatim, so a seeded RUNNING must state one too — the
// status bar's live elapsed segment (and the 1 Hz repaint that drives these
// layout assertions) exists only while it is set.
function setRunning(...streamIds: StreamTabId[]): void {
  for (const streamId of streamIds) {
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.RUNNING,
      runStartedAt: Date.now(),
    });
  }
}

// Identity/category/follow-up-support metadata is shared-substrate state now:
// the App reads it via `streamMetadataFor` from the bound `SessionState`,
// whose authority is the durable summary mirror (`recordSummaryMeta` is a
// whole-object replacement, so each seed states the full record it wants).
function seedStreamMeta(streamId: StreamTabId, meta: StreamSummaryMeta): void {
  childState.streamLogs.recordSummaryMeta(streamId, meta);
  invalidateChildStreams();
}

function markToolUseAgent(...streamIds: StreamTabId[]): void {
  for (const streamId of streamIds) {
    seedStreamMeta(streamId, {
      identity: { kind: 'agent', agent: 'child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      agentCategory: AgentCategory.ToolUse,
    });
  }
}

/** A workflow-task row as the projector builds one, for the suites that seed
 *  a dashboard directly instead of replaying a stream log. */
function taskRow(
  id: string,
  call: WorkflowCallProgress,
): TranscriptRowOf<'workflowTask'> {
  const statusLabel = call.status === 'running' ? 'Running' : 'Planned';
  return {
    kind: 'workflowTask',
    id,
    timestamp: 0,
    level: 'info',
    call,
    line: `${statusLabel}: ${call.label}`,
    statusLabel,
    metadataParts: [],
  };
}

function runningChild(
  executionId: string,
  agentName: string,
  childStreamId: StreamTabId,
): ActiveChildInfo {
  return {
    executionId,
    agentName,
    identity: { kind: 'agent' as const, agent: agentName },
    childStreamId,
    status: STREAM_PHASE.RUNNING,
  };
}

// Child rosters, parent edges, and tombstones live on the adapter-bound
// `SessionState`; these helpers write through its public API and re-derive
// the reactive snapshots the App renders from.
let childState: SessionState;

function seedChildRoster(
  parentStreamId: StreamTabId,
  rows: readonly ActiveChildInfo[],
): void {
  childState.streamLogs.ensureStream(parentStreamId);
  childState.getOrCreateStreamState(parentStreamId, AgentCategory.ToolUse);
  childState.updateStreamState(parentStreamId, (state) => ({
    ...state,
    subagents: [...rows],
  }));
  invalidateChildStreams();
}

function seedParentEdge(
  streamId: StreamTabId,
  parentStreamId: StreamTabId | null,
): void {
  childState.streamLogs.ensureStream(streamId);
  childState.setStreamParent(streamId, parentStreamId);
  invalidateChildStreams();
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
  seedChildRoster(ROOT, [
    runningChild('escape-child-execution', 'child', CHILD),
  ]);
  seedChildRoster(CHILD, [
    runningChild('escape-grandchild-execution', 'grandchild', GRANDCHILD),
  ]);
  seedParentEdge(CHILD, ROOT);
  seedParentEdge(GRANDCHILD, CHILD);
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
    onWorkflowControl: vi.fn(),
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

async function renderDebugApp(
  props: AppProps,
  size: { columns: number; rows: number },
): Promise<InkRenderHandles> {
  const { ink, React } = await loadInk();
  return renderInteractive(ink, React.createElement(App, props), {
    ...size,
    debug: true,
  });
}

function currentFrame(stdout: InkRenderHandles['stdout']): string {
  return stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');
}

function fakeHistory(entries: readonly string[]): InputHistory {
  return {
    push: async () => undefined,
    reverseFind: () => undefined,
    at: (index) => entries[index],
    length: () => entries.length,
  };
}

beforeEach(async () => {
  resetCliState();
  // Summary-mirror metadata seeded via `seedStreamMeta` lives in the shared
  // transcript store and would otherwise leak across tests.
  await defaultSession().transcripts.clear();
  childState = new SessionState(defaultSession());
  bindChildStreamState(childState);
});
afterEach(() => {
  clearApprovals();
  unbindChildStreamState(childState);
  resetCliState();
});

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
    seedStreamMeta(ROOT, {
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'solo-workflow',
      },
      agentCategory: AgentCategory.Workflow,
    });
    patchStream(ROOT, (slice) => ({
      ...slice,
      entries: [
        taskRow('task-planned-only', {
          id: 'draft-alone',
          label: 'Draft alone',
          status: 'planned',
        }),
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
    seedStreamMeta(ROOT, {
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'workflow',
      },
      agentCategory: AgentCategory.Workflow,
    });
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
    syncStreamLog(defaultSession(), ROOT);
    seedChildRoster(ROOT, [
      runningChild('workflow-child-execution', 'duplicate', CHILD),
      runningChild('workflow-review-execution', 'duplicate', GRANDCHILD),
    ]);
    seedParentEdge(CHILD, ROOT);
    seedParentEdge(GRANDCHILD, ROOT);
    const { instance, stdin, stdout, onInterruptStream } =
      await renderWithInterrupt();

    try {
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.includes('workflow · Map (1/1) · 0/2 done'),
      );
      stdin.write('\r');
      await waitFor(() => stdout.output.includes('Inspect · Running'));
      stdin.write('\r');
      await waitFor(() => activeStreamId.get() === CHILD);
      syncStreamLog(defaultSession(), ROOT);
      expect(
        streams
          .get()
          .get(ROOT)
          ?.entries.map((entry) => [entry.id, entry.kind]),
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
    seedChildRoster(ROOT, [
      runningChild('shared-child-execution', 'shared-child', CHILD),
    ]);
    seedParentEdge(CHILD, ROOT);
    seedStreamMeta(ROOT, {
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'ambiguous-workflow',
      },
      agentCategory: AgentCategory.Workflow,
    });
    patchStream(ROOT, (slice) => ({
      ...slice,
      entries: ['first', 'second'].map((id) =>
        taskRow(`task-${id}`, {
          id,
          label: id,
          status: 'running',
          childStreamId: CHILD,
        }),
      ),
    }));
    const onInterruptStream = vi.fn();
    const { instance, stdin, stdout } = await renderDebugApp(
      appProps(onInterruptStream),
      { columns: 100, rows: 30 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('\t');
      await waitFor(() =>
        currentFrame(stdout).includes('ambiguous-workflow · 0/2 done'),
      );
      stdin.write('\r');
      await waitFor(() =>
        currentFrame(stdout)
          .split('\n')
          .some(
            (line) =>
              line.includes('first · Running') && line.includes(POINTER),
          ),
      );
      stdin.write(ARROW_KEYS.Down);
      await waitFor(() =>
        currentFrame(stdout)
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
        currentFrame(stdout)
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
      seedParentEdge(CHILD, null);
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
      seedParentEdge(CHILD, null);
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
      seedParentEdge(CHILD, null);
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
    const { instance, stdin, stdout } = await renderDebugApp(
      { ...appProps(onInterruptStream), onSubmit },
      { columns: 100, rows: 30 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('preserved root draft');
      await waitFor(() =>
        currentFrame(stdout).includes('preserved root draft'),
      );

      seedStreamMeta(CHILD, {
        identity: { kind: 'process', tool: 'bash' },
        // Background Bash carries this synthetic category; identity remains
        // authoritative for the composer capability.
        agentCategory: AgentCategory.ToolUse,
      });
      focusStream(CHILD);
      await waitFor(() => activeStreamId.get() === CHILD);
      await waitFor(
        () => !currentFrame(stdout).includes('preserved root draft'),
      );

      stdin.write('ignored printable submit\r');
      await sleep(30);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(currentFrame(stdout)).not.toContain('ignored printable submit');

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
      await waitFor(() =>
        currentFrame(stdout).includes('preserved root draft'),
      );
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
          textRowFixture(`layout-${streamId}`, 'assistant', transcriptText),
        ],
      }));
    }
    const { instance, stdout } = await renderDebugApp(appProps(vi.fn()), {
      columns: 40,
      rows: 12,
    });
    const visibleTranscriptRows = (): number =>
      (currentFrame(stdout).match(/layout line \d+/gu) ?? []).length;

    try {
      await waitFor(() => visibleTranscriptRows() > 0);
      const rootRows = visibleTranscriptRows();

      focusStream(CHILD);
      await waitFor(() => currentFrame(stdout).includes('Esc parent'));
      const supportedChildRows = visibleTranscriptRows();
      expect(rootRows).toBe(2);
      expect(supportedChildRows).toBe(7);

      for (const fixture of [
        {
          identity: { kind: 'agent' as const, agent: 'structured-child' },
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
          agentCategory: AgentCategory.ToolUse,
        },
        {
          identity: { kind: 'agent' as const, agent: 'workflow-child' },
          agentCategory: AgentCategory.Workflow,
        },
        {
          identity: { kind: 'process' as const, tool: 'bash' },
          agentCategory: AgentCategory.ToolUse,
        },
        {
          identity: {
            kind: 'agent' as const,
            agent: 'codex',
            tool: 'codex',
          },
          agentCategory: AgentCategory.ToolUse,
        },
      ] satisfies readonly StreamSummaryMeta[]) {
        const writesBeforePatch = stdout.writes.length;
        seedStreamMeta(CHILD, fixture);
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
    seedStreamMeta(CHILD, {
      identity: { kind: 'agent', agent: 'child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      agentCategory: AgentCategory.ToolUse,
    });
    focusStream(CHILD);
    const transcriptText = Array.from(
      { length: 20 },
      (_, index) => `unsupported list line ${index + 1}`,
    ).join('\n');
    patchStream(CHILD, (slice) => ({
      ...slice,
      entries: [
        textRowFixture('unsupported-list-layout', 'assistant', transcriptText),
      ],
    }));
    const { instance, stdin, stdout } = await renderDebugApp(
      appProps(vi.fn()),
      viewport,
    );
    const visibleTranscriptRows = (): number =>
      (currentFrame(stdout).match(/unsupported list line \d+/gu) ?? []).length;

    try {
      await waitFor(() => visibleTranscriptRows() === 10);
      expect(visibleTranscriptRows()).toBe(10);
      expect(currentFrame(stdout)).not.toContain('Session list');

      stdin.write('\t');
      await waitFor(
        () =>
          currentFrame(stdout).includes('Session list') &&
          visibleTranscriptRows() === 4,
      );
      expect(currentFrame(stdout)).toContain('Session list');
      expect(visibleTranscriptRows()).toBe(4);

      stdin.write('\t');
      await waitFor(() => visibleTranscriptRows() === 10);
      expect(visibleTranscriptRows()).toBe(10);
      expect(currentFrame(stdout)).not.toContain('Session list');
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
      agentCategory: AgentCategory.ToolUse,
    },
    {
      name: 'workflow agent',
      identity: { kind: 'agent' as const, agent: 'workflow-child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      agentCategory: AgentCategory.Workflow,
    },
    {
      name: 'multi-agent workflow',
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'workflow-child',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      agentCategory: AgentCategory.Workflow,
    },
    {
      name: 'background bash process',
      identity: { kind: 'process' as const, tool: 'bash' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      agentCategory: AgentCategory.ToolUse,
    },
    {
      name: 'terminal-backed agent',
      identity: {
        kind: 'agent' as const,
        agent: 'codex',
        tool: 'codex',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
      agentCategory: AgentCategory.ToolUse,
    },
    {
      name: 'missing metadata',
      identity: undefined,
      userFollowUpSupport: undefined,
      agentCategory: undefined,
    },
  ])(
    'ignores printable submission for a running $name child',
    async (fixture) => {
      seedChildHierarchy();
      seedStreamMeta(CHILD, {
        identity: fixture.identity,
        userFollowUpSupport: fixture.userFollowUpSupport,
        agentCategory: fixture.agentCategory,
      });
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
      await waitFor(() => stdout.output.includes('Session list'));
      const beforeListCancel = stdout.output.length;
      stdin.write(ESC);
      await waitFor(() =>
        stdout.output.slice(beforeListCancel).includes('Esc parent'),
      );

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();

      const beforeListFocus = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeListFocus).includes('Session list'),
      );
      const beforeTabReturn = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeTabReturn).includes('Esc parent'),
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

      expect(stdout.output).not.toContain('Session list');
      expect(activeStreamId.get()).toBe(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('interrupts a promoted top-level stream because it has no back relation', async () => {
    seedChildHierarchy();
    seedParentEdge(CHILD, null);
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

      expect(stdout.output).not.toContain('Session list');
    } finally {
      instance.unmount();
    }
  });
});

// The two enqueue calls below recur across this describe block: a
// stream-scoped approval on an unrelated stream (which must never satisfy an
// assertion on its own) and a session-wide (streamId: '') approval that
// should promote onto whatever stream ends up visible.
function enqueueOtherStreamInquiry(
  requestId: string,
  question: string,
  threadId: string,
): void {
  void enqueueApproval({
    kind: 'externalInquiry',
    data: {
      requestId,
      mode: 'followUp',
      question,
      threadId,
      allowBypass: false,
      streamId: 'other-stream',
    },
  });
}

function enqueueSessionInquiry(
  requestId: string,
  question: string,
  threadId: string,
): void {
  void enqueueApproval({
    kind: 'externalInquiry',
    data: {
      requestId,
      mode: 'followUp',
      question,
      threadId,
      allowBypass: false,
      streamId: '',
    },
  });
}

describe('App approval surface ownership', () => {
  it('promotes a session-wide approval when a child becomes the scoped root', async () => {
    seedChildHierarchy();
    focusStream(ROOT);
    enqueueOtherStreamInquiry(
      'external-other-new-scope',
      'Wait outside the new scope.',
      'ei_000000000007',
    );
    enqueueSessionInquiry(
      'external-session-new-scope',
      'Verify the newly scoped child.',
      'ei_000000000008',
    );
    const { instance, stdin, stdout } = await renderApp(appProps(vi.fn()));

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('Session list'));
      stdin.write(ARROW_KEYS.Down);
      await waitFor(() =>
        stripAnsi(stdout.output)
          .split('\n')
          .some((line) => line.includes('child') && line.includes(POINTER)),
      );
      stdin.write('\r');
      await waitFor(() => activeStreamId.get() === CHILD);
      await waitFor(() => {
        const pending = currentApproval.get()?.payload;
        return (
          pending?.kind === 'externalInquiry' &&
          pending.data.requestId === 'external-session-new-scope'
        );
      });
      await waitFor(() =>
        stdout.output.includes('Verify the newly scoped child.'),
      );
      expect(stdout.output).not.toContain('Wait outside the new scope.');
    } finally {
      instance.unmount();
    }
  });

  it('focuses a dashboard root before presenting its bound approval', async () => {
    seedRootStream();
    setRunning(CHILD);
    seedChildRoster(ROOT, [
      runningChild('approval-task-execution', 'approval-task', CHILD),
    ]);
    seedParentEdge(CHILD, ROOT);
    seedStreamMeta(ROOT, {
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'approval-workflow',
      },
      agentCategory: AgentCategory.Workflow,
    });
    patchStream(ROOT, (slice) => ({
      ...slice,
      entries: [
        taskRow('approval-task', {
          id: 'approval-task',
          label: 'Approval task',
          status: 'running',
          childStreamId: CHILD,
        }),
      ],
    }));
    focusStream(CHILD);
    enqueueOtherStreamInquiry(
      'external-other-dashboard',
      'Wait outside the dashboard root.',
      'ei_000000000009',
    );
    void enqueueApproval({
      kind: 'planApproval',
      data: {
        requestId: 'plan-dashboard-root',
        streamId: ROOT,
        plan: { objective: 'Verify the dashboard root.' },
        goalEnabled: false,
      },
    });
    const { instance, stdin, stdout } = await renderApp(appProps(vi.fn()));

    try {
      stdin.write('\t');
      await waitFor(() => activeStreamId.get() === ROOT);
      await waitFor(() => {
        const pending = currentApproval.get()?.payload;
        return (
          pending?.kind === 'planApproval' &&
          pending.data.requestId === 'plan-dashboard-root'
        );
      });
      await waitFor(() => stdout.output.includes('Approve plan?'));
      expect(stdout.output).not.toContain('Wait outside the dashboard root.');
    } finally {
      instance.unmount();
    }
  });

  it('promotes a session-wide approval against the post-Escape root', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    enqueueOtherStreamInquiry(
      'external-other-after-escape',
      'Wait outside the destination root.',
      'ei_000000000005',
    );
    enqueueSessionInquiry(
      'external-session-after-escape',
      'Verify the destination root.',
      'ei_000000000006',
    );
    const { instance, stdin, stdout } = await renderApp(appProps(vi.fn()));

    try {
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT);
      await waitFor(() => {
        const pending = currentApproval.get()?.payload;
        return (
          pending?.kind === 'externalInquiry' &&
          pending.data.requestId === 'external-session-after-escape'
        );
      });
      await waitFor(() =>
        stdout.output.includes('Verify the destination root.'),
      );
      expect(stdout.output).not.toContain('Wait outside the destination root.');
    } finally {
      instance.unmount();
    }
  });

  it('promotes a session-wide approval from a scoped-list root', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    enqueueOtherStreamInquiry(
      'external-other-scoped',
      'Wait outside the scoped list.',
      'ei_000000000003',
    );
    enqueueSessionInquiry(
      'external-session-scoped',
      'Verify the scoped child session.',
      'ei_000000000004',
    );
    const { instance, stdin, stdout } = await renderApp(appProps(vi.fn()));

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('inquiry'));
      stdin.write(ARROW_KEYS.Up);
      stdin.write('\r');
      await waitFor(() => {
        const pending = currentApproval.get()?.payload;
        return (
          pending?.kind === 'externalInquiry' &&
          pending.data.requestId === 'external-session-scoped'
        );
      });
      await waitFor(() =>
        stdout.output.includes('Verify the scoped child session.'),
      );
      expect(stdout.output).not.toContain('Wait outside the scoped list.');
    } finally {
      instance.unmount();
    }
  });

  it('promotes an approval-only dashboard before workflow rows exist', async () => {
    seedRootStream();
    seedStreamMeta(ROOT, {
      identity: {
        kind: 'multiAgentWorkflow',
        workflowName: 'starting-workflow',
      },
      agentCategory: AgentCategory.Workflow,
    });
    patchStream(ROOT, (slice) => ({ ...slice, entries: [] }));
    enqueueOtherStreamInquiry(
      'external-other',
      'Wait outside the active stream.',
      'ei_000000000001',
    );
    enqueueSessionInquiry(
      'external-session',
      'Verify the workflow before it emits rows.',
      'ei_000000000002',
    );
    const { instance, stdin, stdout } = await renderApp(appProps(vi.fn()));

    try {
      stdin.write('\t');
      await waitFor(() => {
        const pending = currentApproval.get()?.payload;
        return (
          pending?.kind === 'externalInquiry' &&
          pending.data.requestId === 'external-session'
        );
      });
      await waitFor(() =>
        stdout.output.includes('Verify the workflow before it emits rows.'),
      );
      expect(stdout.output).not.toContain('Wait outside the active stream.');
    } finally {
      instance.unmount();
    }
  });
});
