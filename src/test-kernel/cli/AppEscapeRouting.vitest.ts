import '@test/support/defaultSessionTestSetup';

import { setTimeout as sleep } from 'node:timers/promises';

import { Effect } from 'effect';

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
  activeRunId,
  closeForegroundReader,
  focusRun,
  expandedRuns,
  foregroundReader,
  infoPane,
  openInfoPane,
  openWorkflowPopup,
  resetCliState,
  rootRunPending,
  rootRunId,
  updateWorkflowPopupView,
  workflowPopupView,
} from '@cli/chat/tui/state/cliState';
import {
  AgentCategory,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type ActiveChildInfo,
  type RunId,
  type WorkflowCallProgress,
} from '@shared/schemas';
import type { WorkflowTaskRow } from '@shared/transcript';
import type { TranscriptRow } from '@shared/transcript';
import { runUnreadableMessage } from '@shared/runs/runStatusDisplay';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { workflowRunModel } from '@shared/runs/workflowRunModel';
import { textRowFixture } from '@test/support/transcriptRowFixtures';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

vi.mock('@cli/runtime/shortcutLabels', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/shortcutLabels')>();
  return { ...actual, defaultShortcutModifierLabel: () => 'Esc' };
});

const ROOT = 'escape-root' as RunId;
const CHILD = 'escape-child' as RunId;
const GRANDCHILD = 'escape-grandchild' as RunId;
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
/** The runs a case names, as the fold states them; every seed rewrites
 *  the whole view the App reads. */
const seeded = new Map<RunId, RunView>();
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
      runId: payload.data.runId as RunId,
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
function seedRun(
  id: RunId,
  over: Partial<Omit<RunView, 'category'>> & {
    readonly category?: RunView['category'];
  } = {},
): void {
  const current = seeded.get(id);
  seeded.set(id, makeRunView({ ...(current ?? {}), ...over, id }) as RunView);
  syncSeededView();
}
function transcriptOf(rows: readonly TranscriptRow[]): RunView['transcript'] {
  return {
    rows: [...rows],
    taskGroups: [],
    settledRows: rows.length,
    run: workflowRunModel({
      taskGroups: [],
      rows,
      plan: undefined,
      runPhase: RUN_PHASE.RUNNING,
      runDurablyFinal: false,
      childProgress: new Map(),
    }),
  };
}
function setRunning(...runIds: RunId[]): void {
  for (const runId of runIds) {
    seedRun(runId, {
      status: RUN_PHASE.RUNNING,
      runStartedAt: Date.now(),
    });
  }
}
/** Summary metadata as the fold states it: an absent identity or support
 *  level is the fold's null and unsupported, never the fixture's default. */
function seedRunMeta(
  runId: RunId,
  meta: {
    identity?: RunView['identity'];
    userFollowUpSupport?: RunView['followUpSupport'];
    agentCategory?: RunView['category'];
  },
): void {
  seedRun(runId, {
    identity: meta.identity,
    followUpSupport:
      meta.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    ...(meta.agentCategory !== undefined
      ? { category: meta.agentCategory }
      : {}),
  });
}
function markToolUseAgent(...runIds: RunId[]): void {
  for (const runId of runIds) {
    seedRunMeta(runId, {
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

function runningChild(childRunId: RunId, agentName: string): ActiveChildInfo {
  return {
    childRunId,
    agentName,
    identity: { kind: 'agent' as const, agent: agentName },
    status: RUN_PHASE.RUNNING,
  };
}

// Seed the child rosters and parent edges through the session event fold.
function seedChildRoster(
  parentRunId: RunId,
  rows: readonly ActiveChildInfo[],
): void {
  seedRun(parentRunId);
  for (const row of rows) {
    seedRun(row.childRunId, {
      label: row.agentName,
      identity: row.identity,
      status: row.status ?? RUN_PHASE.COMPLETED,
    });
    seedParentEdge(row.childRunId, parentRunId);
  }
}
function seedParentEdge(runId: RunId, parentRunId: RunId | null): void {
  const parent = parentRunId === null ? undefined : seeded.get(parentRunId);
  seedRun(runId, {
    parentId: parentRunId,
    ancestors:
      parentRunId === null
        ? []
        : [
            ...(parent?.ancestors ?? []),
            { id: parentRunId, label: parent?.label ?? parentRunId },
          ],
  });
}
function seedRootRun(): void {
  rootRunId.set(ROOT);
  rootRunPending.set(true);
  setRunning(ROOT);
  focusRun(ROOT);
}

function seedChildHierarchy(): void {
  seedRootRun();
  setRunning(CHILD, GRANDCHILD);
  markToolUseAgent(CHILD, GRANDCHILD);
  seedChildRoster(ROOT, [runningChild(CHILD, 'child')]);
  seedChildRoster(CHILD, [runningChild(GRANDCHILD, 'grandchild')]);
  seedParentEdge(CHILD, ROOT);
  seedParentEdge(GRANDCHILD, CHILD);
}

function finishNestedHierarchyAndFocusRoot(): void {
  for (const runId of [GRANDCHILD, CHILD]) {
    seedRun(runId, { status: RUN_PHASE.COMPLETED });
  }
  focusRun(ROOT);
}

function appProps(onInterruptRun: (runId: RunId) => void): AppProps {
  return {
    onSubmit: vi.fn(),
    onKillRun: vi.fn(),
    onWorkflowControl: vi.fn(),
    canInterruptRun: () => true,
    onCtrlC: vi.fn(),
    onInterruptRun,
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
): Promise<InkRenderHandles & { onInterruptRun: ReturnType<typeof vi.fn> }> {
  const onInterruptRun = vi.fn();
  const handles = await renderApp({
    ...appProps(onInterruptRun),
    ...extraProps,
  });
  return { ...handles, onInterruptRun };
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
    push: () => Effect.void,
    reverseFind: () => undefined,
    at: (index) => entries[index],
    length: () => entries.length,
  };
}

beforeAll(bindTestSessionView);
beforeEach(() => {
  resetCliState();
  seeded.clear();
  seededApprovals = [];
  syncSeededView();
});
afterEach(() => {
  clearSeededApprovals();
  resetCliState();
});

describe('App foreground Escape ownership', () => {
  it('lets a foreground information pane own Escape before child back', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    openInfoPane('Reference', 'Foreground content');
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await waitFor(() => infoPane.get() === undefined);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(CHILD);
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('opens a workflow as a popup over its parent, never as a viewport', async () => {
    const WORKFLOW = 'escape-workflow' as RunId;
    seedRootRun();
    setRunning(WORKFLOW, CHILD);
    seedChildRoster(ROOT, [
      {
        ...runningChild(WORKFLOW, 'workflow'),
        identity: { kind: 'multiAgentWorkflow', workflowName: 'workflow' },
      },
    ]);
    seedParentEdge(WORKFLOW, ROOT);
    seedRunMeta(WORKFLOW, {
      identity: { kind: 'multiAgentWorkflow', workflowName: 'workflow' },
      agentCategory: AgentCategory.Workflow,
    });
    seedRun(WORKFLOW, {
      transcript: transcriptOf([
        taskRow('task-child', {
          id: 'inspect',
          label: 'Inspect',
          status: 'running',
          childRunId: CHILD,
        }),
      ]),
    });
    seedChildRoster(WORKFLOW, [runningChild(CHILD, 'inspect')]);
    seedParentEdge(CHILD, WORKFLOW);
    markToolUseAgent(CHILD);
    seedApproval({
      kind: 'planApproval',
      data: {
        requestId: 'plan-unrelated',
        runId: GRANDCHILD,
        plan: { objective: 'Keep this unrelated request queued.' },
        goalEnabled: false,
      },
    });
    seedApproval({
      kind: 'planApproval',
      data: {
        requestId: 'plan-queued-workflow-child',
        runId: CHILD,
        plan: { objective: 'Promote the queued workflow child.' },
        goalEnabled: false,
      },
    });
    const { instance, stdin, stdout, onInterruptRun } =
      await renderWithInterrupt();
    const emit = vi.spyOn(defaultSession(), 'publish');

    try {
      expandedRuns.set(new Map([[ROOT, true]]));
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
      expect(activeRunId.get()).toBe(ROOT);
      // View state the user set inside the popup survives the round trips
      // below; only opening a different workflow would start fresh.
      updateWorkflowPopupView({ expanded: new Set(['queued']) });

      // An approval bound to the workflow stream surfaces over the popup,
      // and the popup comes back once it is answered.
      seedApproval({
        kind: 'planApproval',
        data: {
          requestId: 'plan-workflow-popup',
          runId: WORKFLOW,
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
          runId: CHILD,
          plan: { objective: 'Verify the child result.' },
          goalEnabled: false,
        },
      });
      await waitFor(() => stdout.output.includes('Verify the child result.'));
      expect(activeRunId.get()).toBe(ROOT);
      expect(emit).not.toHaveBeenCalled();
      clearSeededApprovals();
      await waitFor(() => currentApproval.get() === undefined);
      expect(foregroundReader.get()?.kind).toBe('workflow');
      closeForegroundReader();
      expect(activeRunId.get()).toBe(ROOT);
      openWorkflowPopup(WORKFLOW);

      // Enter on the task focuses that agent; Esc returns to main with the
      // popup back where it was.
      stdin.write('\r');
      await waitFor(() => activeRunId.get() === CHILD);
      expect(foregroundReader.get()).toBeUndefined();
      stdin.write(ESC);
      await waitFor(() => activeRunId.get() === ROOT, {
        timeoutMs: 1_000,
      });
      await waitFor(() => foregroundReader.get()?.kind === 'workflow');
      expect(workflowPopupView.get().expanded.has('queued')).toBe(true);
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
      instance.unmount();
    }
  });

  it('walks nested children back one immediate parent per bare Escape', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await waitFor(() => activeRunId.get() === CHILD);
      stdin.write(ESC);
      await waitFor(() => activeRunId.get() === ROOT);

      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not apply delayed child back after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late reference');
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late reference');
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeRunId.get() === ROOT);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(ROOT);
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('treats a second bare Escape as fresh after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeRunId.get() === ROOT);
      stdin.write(ESC);
      await waitFor(() => onInterruptRun.mock.calls.length === 1);

      expect(onInterruptRun).toHaveBeenCalledWith(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back when the child is promoted', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      seedParentEdge(CHILD, null);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(CHILD);
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('treats a second Escape as fresh after topology invalidates the pending action', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      seedParentEdge(CHILD, null);
      stdin.write(ESC);
      await waitFor(() => onInterruptRun.mock.calls.length === 1);

      expect(activeRunId.get()).toBe(CHILD);
      expect(onInterruptRun).toHaveBeenCalledWith(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it.each([
    {
      // Completed child: its input is disabled, so the printable key fails the
      // chord and must be preserved into the parent input that back enables.
      name: 'preserves a printable failed chord when back enables parent input',
      childStatus: RUN_PHASE.COMPLETED,
    },
    {
      // Running child: its input is enabled, so the printable key must not be
      // duplicated into the parent input when back resolves.
      name: 'does not duplicate a printable failed chord from enabled input',
      childStatus: RUN_PHASE.RUNNING,
    },
  ])('$name', async ({ childStatus }) => {
    seedChildHierarchy();
    seedRun(CHILD, { status: childStatus });
    focusRun(CHILD);
    const onSubmit = vi.fn();
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt({
      onSubmit,
    });

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write('q');
      await waitFor(() => activeRunId.get() === ROOT);
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith('q', undefined, undefined);
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not resolve Esc-digit focus after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late chord reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late chord reference');
      stdin.write('1');
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late chord reference');
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('preserves two quick bare-Escape actions through the chord window', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ESC);
      await waitFor(() => activeRunId.get() === CHILD);
      await waitFor(() => activeRunId.get() === ROOT);

      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('interrupts the root only once for two quick bare Escapes', async () => {
    seedChildHierarchy();
    focusRun(ROOT);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ESC);
      await waitFor(() => onInterruptRun.mock.calls.length >= 1);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(ROOT);
      expect(onInterruptRun).toHaveBeenCalledOnce();
      expect(onInterruptRun).toHaveBeenCalledWith(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('keeps an Esc-digit focus target after the bare-Escape window expires', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    expandedRuns.set(
      new Map([
        [ROOT, true],
        [CHILD, true],
      ]),
    );
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write('3');
      await waitFor(() => activeRunId.get() === GRANDCHILD);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(activeRunId.get()).toBe(GRANDCHILD);
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('collapses an incapable child composer while preserving navigation and the root draft', async () => {
    seedChildHierarchy();
    focusRun(ROOT);
    const onSubmit = vi.fn();
    const onInterruptRun = vi.fn();
    const { instance, stdin, stdout } = await renderDebugApp(
      { ...appProps(onInterruptRun), onSubmit },
      { columns: 100, rows: 30 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('preserved root draft');
      await waitFor(() =>
        currentFrame(stdout).includes('preserved root draft'),
      );

      seedRunMeta(CHILD, {
        identity: { kind: 'process', tool: 'bash' },
        // Background Bash carries this synthetic category; identity remains
        // authoritative for the composer capability.
        agentCategory: AgentCategory.ToolUse,
      });
      focusRun(CHILD);
      await waitFor(() => activeRunId.get() === CHILD);
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
          foregroundReader.get()?.runId === CHILD,
      );
      stdin.write(ESC);
      await waitFor(() => foregroundReader.get() === undefined);
      stdin.write(ESC);
      await waitFor(() => activeRunId.get() === ROOT);
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
      expect(onInterruptRun).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('shows an unreadable root as read-only', async () => {
    seedChildHierarchy();
    const onSubmit = vi.fn();
    const detail = runUnreadableMessage('checkpoint is malformed');
    const { instance, stdin, stdout } = await renderDebugApp(
      { ...appProps(vi.fn()), onSubmit },
      { columns: 240, rows: 30 },
    );

    try {
      seedRun(ROOT, { readOnly: true, statusDetail: detail });
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

  it.each([RUN_PHASE.RUNNING, RUN_PHASE.WAITING])(
    'keeps the composer enabled for a %s tool-use agent child',
    async (status) => {
      seedChildHierarchy();
      seedRun(CHILD, { status });
      focusRun(CHILD);
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
      seedRunMeta(CHILD, {
        identity: fixture.identity,
        userFollowUpSupport: fixture.userFollowUpSupport,
        agentCategory: fixture.agentCategory,
      });
      focusRun(CHILD);
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
    focusRun(CHILD);
    const { instance, stdin, stdout, onInterruptRun } =
      await renderWithInterrupt();

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('Session list'));
      const beforeListCancel = stdout.output.length;
      stdin.write(ESC);
      await waitFor(() =>
        stdout.output.slice(beforeListCancel).includes('Esc parent'),
      );

      expect(activeRunId.get()).toBe(CHILD);
      expect(onInterruptRun).not.toHaveBeenCalled();

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
    focusRun(ROOT);
    const { instance, stdin, stdout } = await renderWithInterrupt();

    try {
      for (const arrowInput of Object.values(ARROW_KEYS)) {
        stdin.write(arrowInput);
      }
      await sleep(30);

      expect(stdout.output).not.toContain('Session list');
      expect(activeRunId.get()).toBe(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('interrupts a promoted top-level stream because it has no back relation', async () => {
    seedChildHierarchy();
    seedParentEdge(CHILD, null);
    focusRun(CHILD);
    const { instance, stdin, onInterruptRun } = await renderWithInterrupt();

    try {
      stdin.write(ESC);
      await waitFor(() => onInterruptRun.mock.calls.length === 1);

      expect(onInterruptRun).toHaveBeenCalledWith(CHILD);
      expect(activeRunId.get()).toBe(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it('returns keyboard ownership to prompt history after stopping the root', async () => {
    seedRootRun();
    const onInterruptRun = vi.fn((runId: RunId) => {
      seedRun(runId, { status: RUN_PHASE.CANCELLED });
      rootRunPending.set(false);
    });
    const { instance, stdin, stdout } = await renderApp({
      ...appProps(onInterruptRun),
      history: fakeHistory(['older prompt', 'latest prompt']),
    });

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ARROW_KEYS.Up);
      await waitFor(() => onInterruptRun.mock.calls.length === 1);
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
// assertion on its own) and a session-wide (runId: '') approval that
// should promote onto whatever stream ends up visible.
