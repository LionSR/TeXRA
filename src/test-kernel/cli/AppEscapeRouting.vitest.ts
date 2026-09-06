import '@test/support/defaultSessionTestSetup';

import { setTimeout as sleep } from 'node:timers/promises';

import stripAnsi from 'strip-ansi';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { App, type AppProps } from '@cli/chat/tui/App';
import { ESC_META_CHORD_INTERRUPT_DELAY_MS } from '@cli/chat/tui/appInteractionPolicy';
import {
  currentApproval,
  type ApprovalPayload,
} from '@cli/chat/tui/state/approvalQueue';
import { POINTER } from '@cli/tui/ui/glyphs';
import type { InputHistory } from '@cli/chat/tui/history/inputHistory';
import {
  activeStreamId,
  closeForegroundReader,
  focusStream,
  foregroundReader,
  infoPane,
  openInfoPane,
  openWorkflowPopup,
  resetCliState,
  rootRunPending,
  rootStreamId,
  updateWorkflowPopupView,
  workflowPopupView,
} from '@cli/chat/tui/state/cliState';
import {
  AgentCategory,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type ActiveChildInfo,
  type StreamTabId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import type { WorkflowTaskRow } from '@shared/transcript';
import type { TranscriptRow } from '@shared/transcript';
import { streamUnreadableMessage } from '@shared/streams/streamStatusDisplay';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import { workflowRunModel } from '@shared/streams/workflowRunModel';
import { textRowFixture } from '@test/support/transcriptRowFixtures';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import type { StreamSummaryMeta } from '@transcript/StreamSummaryCacheStore';
import {
  bindTestSessionView,
  makeStreamView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

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
/** The streams a case names, as the fold states them; every seed rewrites
 *  the whole view the App reads. */
const seeded = new Map<StreamTabId, StreamView>();
/** The approvals the fold lists: `approval.requested` facts not yet resolved. */
let seededApprovals: SessionView['approvals'] = [];
function syncSeededView(): void {
  seedView(viewWith([...seeded.values()], { approvals: seededApprovals }));
}
/** One pending request as its `approval.requested` fact folds. */
function seedApproval(payload: ApprovalPayload): void {
  seededApprovals = [
    ...seededApprovals,
    {
      streamId: payload.data.streamId as StreamTabId,
      requestId: payload.data.requestId,
      payload,
    },
  ];
  syncSeededView();
}
/** Every pending request resolved: the runtime's `approval.resolved` folded. */
function clearSeededApprovals(): void {
  seededApprovals = [];
  syncSeededView();
}
function seedStream(
  id: StreamTabId,
  over: Partial<Omit<StreamView, 'category'>> & {
    readonly category?: StreamView['category'];
  } = {},
): void {
  const current = seeded.get(id);
  seeded.set(
    id,
    makeStreamView({ ...(current ?? {}), ...over, id }) as StreamView,
  );
  syncSeededView();
}
function transcriptOf(
  rows: readonly TranscriptRow[],
): StreamView['transcript'] {
  return {
    rows: [...rows],
    taskGroups: [],
    settledRows: rows.length,
    run: workflowRunModel({
      taskGroups: [],
      rows,
      plan: undefined,
      streamPhase: STREAM_PHASE.RUNNING,
      runDurablyFinal: false,
      childProgress: new Map(),
    }),
  };
}
function setRunning(...streamIds: StreamTabId[]): void {
  for (const streamId of streamIds) {
    seedStream(streamId, {
      status: STREAM_PHASE.RUNNING,
      runStartedAt: Date.now(),
    });
  }
}
/** Summary metadata as the fold states it: an absent identity or support
 *  level is the fold's null and unsupported, never the fixture's default. */
function seedStreamMeta(streamId: StreamTabId, meta: StreamSummaryMeta): void {
  seedStream(streamId, {
    identity: meta.identity ?? null,
    followUpSupport:
      meta.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    ...(meta.agentCategory !== undefined
      ? { category: meta.agentCategory }
      : {}),
  });
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
function taskRow(id: string, call: WorkflowCallProgress): WorkflowTaskRow {
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

// Seed the child rosters and parent edges through the session event fold.
function seedChildRoster(
  parentStreamId: StreamTabId,
  rows: readonly ActiveChildInfo[],
): void {
  seedStream(parentStreamId);
  for (const row of rows) {
    seedStream(row.childStreamId, {
      executionId: row.executionId,
      label: row.agentName,
      identity: row.identity,
      status: row.status ?? STREAM_PHASE.COMPLETED,
    });
    seedParentEdge(row.childStreamId, parentStreamId);
  }
}
function seedParentEdge(
  streamId: StreamTabId,
  parentStreamId: StreamTabId | null,
): void {
  const parent =
    parentStreamId === null ? undefined : seeded.get(parentStreamId);
  seedStream(streamId, {
    parentId: parentStreamId,
    ancestors:
      parentStreamId === null
        ? []
        : [
            ...(parent?.ancestors ?? []),
            { id: parentStreamId, label: parent?.label ?? parentStreamId },
          ],
  });
}
function seedRootStream(): void {
  rootStreamId.set(ROOT);
  rootRunPending.set(true);
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
    seedStream(streamId, { status: STREAM_PHASE.COMPLETED });
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
    canInterruptStream: () => true,
    onCtrlC: vi.fn(),
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

beforeAll(bindTestSessionView);
beforeEach(async () => {
  resetCliState();
  seeded.clear();
  seededApprovals = [];
  syncSeededView();
  await defaultSession().transcripts.clear();
});
afterEach(() => {
  clearSeededApprovals();
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

  it('opens a workflow as a popup over its parent, never as a viewport', async () => {
    const WORKFLOW = 'escape-workflow' as StreamTabId;
    seedRootStream();
    setRunning(WORKFLOW, CHILD);
    seedChildRoster(ROOT, [
      {
        ...runningChild('workflow-execution', 'workflow', WORKFLOW),
        identity: { kind: 'multiAgentWorkflow', workflowName: 'workflow' },
      },
    ]);
    seedParentEdge(WORKFLOW, ROOT);
    seedStreamMeta(WORKFLOW, {
      identity: { kind: 'multiAgentWorkflow', workflowName: 'workflow' },
      agentCategory: AgentCategory.Workflow,
    });
    seedStream(WORKFLOW, {
      transcript: transcriptOf([
        taskRow('task-child', {
          id: 'inspect',
          label: 'Inspect',
          status: 'running',
          childStreamId: CHILD,
        }),
      ]),
    });
    seedChildRoster(WORKFLOW, [
      runningChild('child-execution', 'inspect', CHILD),
    ]);
    seedParentEdge(CHILD, WORKFLOW);
    markToolUseAgent(CHILD);
    seedApproval({
      kind: 'planApproval',
      data: {
        requestId: 'plan-unrelated',
        streamId: GRANDCHILD,
        plan: { objective: 'Keep this unrelated request queued.' },
        goalEnabled: false,
      },
    });
    seedApproval({
      kind: 'planApproval',
      data: {
        requestId: 'plan-queued-workflow-child',
        streamId: CHILD,
        plan: { objective: 'Promote the queued workflow child.' },
        goalEnabled: false,
      },
    });
    const { instance, stdin, stdout, onInterruptStream } =
      await renderWithInterrupt();
    const emit = vi.spyOn(defaultSession(), 'publish');

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('workflow Running'));
      stdin.write(ARROW_KEYS.Down);
      stdin.write('\r');
      // The workflow row opens the popup over main, promotes direct-child
      // approvals, and keeps main as the underlying viewport.
      await waitFor(() => foregroundReader.get()?.kind === 'workflow');
      await waitFor(() =>
        stdout.output.includes('Promote the queued workflow child.'),
      );
      expect(stdout.output).not.toContain(
        'Keep this unrelated request queued.',
      );
      clearSeededApprovals();
      await waitFor(() => currentApproval.get() === undefined);
      await waitFor(() => stdout.output.includes('Inspect · Running'));
      expect(activeStreamId.get()).toBe(ROOT);
      // View state the user set inside the popup survives the round trips
      // below; only opening a different workflow would start fresh.
      updateWorkflowPopupView({ expanded: new Set(['queued']) });

      // An approval bound to the workflow stream surfaces over the popup,
      // and the popup comes back once it is answered.
      seedApproval({
        kind: 'planApproval',
        data: {
          requestId: 'plan-workflow-popup',
          streamId: WORKFLOW,
          plan: { objective: 'Verify the workflow.' },
          goalEnabled: false,
        },
      });
      await waitFor(() => stdout.output.includes('Approve plan?'));
      clearSeededApprovals();
      await waitFor(() => currentApproval.get() === undefined);
      expect(foregroundReader.get()?.kind).toBe('workflow');

      // A real announcement from one of the workflow's own agent calls takes
      // the same foreground modal without moving the viewport underneath it.
      seedApproval({
        kind: 'planApproval',
        data: {
          requestId: 'plan-workflow-child',
          streamId: CHILD,
          plan: { objective: 'Verify the child result.' },
          goalEnabled: false,
        },
      });
      await waitFor(() => stdout.output.includes('Verify the child result.'));
      expect(activeStreamId.get()).toBe(ROOT);
      expect(emit).not.toHaveBeenCalled();
      clearSeededApprovals();
      await waitFor(() => currentApproval.get() === undefined);
      expect(foregroundReader.get()?.kind).toBe('workflow');
      closeForegroundReader();
      expect(activeStreamId.get()).toBe(ROOT);
      openWorkflowPopup(WORKFLOW);

      // Enter on the task focuses that agent; Esc returns to main with the
      // popup back where it was.
      stdin.write('\r');
      await waitFor(() => activeStreamId.get() === CHILD);
      expect(foregroundReader.get()).toBeUndefined();
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT, {
        timeoutMs: 1_000,
      });
      await waitFor(() => foregroundReader.get()?.kind === 'workflow');
      expect(workflowPopupView.get().expanded.has('queued')).toBe(true);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
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
    seedStream(CHILD, { status: childStatus });
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

      expect(onSubmit).toHaveBeenCalledWith('q', undefined, undefined);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it.each(Object.entries(ARROW_KEYS))(
    'resolves deferred child back before %s',
    async (_name, arrowInput) => {
      seedChildHierarchy();
      seedStream(CHILD, { status: STREAM_PHASE.COMPLETED });
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

      expect(onSubmit).toHaveBeenCalledWith(
        'preserved root draft',
        undefined,
        undefined,
      );
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('shows an unreadable root as read-only', async () => {
    seedChildHierarchy();
    const onSubmit = vi.fn();
    const detail = streamUnreadableMessage('checkpoint is malformed');
    const { instance, stdin, stdout } = await renderDebugApp(
      { ...appProps(vi.fn()), onSubmit },
      { columns: 240, rows: 30 },
    );

    try {
      seedStream(ROOT, { readOnly: true, statusDetail: detail });
      await waitFor(() =>
        currentFrame(stdout).replaceAll(/\s+/gu, ' ').includes(detail),
      );

      stdin.write('must not submit\r');
      await sleep(30);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it.each([STREAM_PHASE.RUNNING, STREAM_PHASE.WAITING])(
    'keeps the composer enabled for a %s tool-use agent child',
    async (status) => {
      seedChildHierarchy();
      seedStream(CHILD, { status });
      focusStream(CHILD);
      const onSubmit = vi.fn();
      const { instance, stdin } = await renderWithInterrupt({ onSubmit });

      try {
        stdin.write('child follow-up\r');
        await waitFor(() => onSubmit.mock.calls.length === 1);
        expect(onSubmit).toHaveBeenCalledWith(
          'child follow-up',
          undefined,
          undefined,
        );
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
      seedStream(streamId, { status: STREAM_PHASE.CANCELLED });
      rootRunPending.set(false);
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
