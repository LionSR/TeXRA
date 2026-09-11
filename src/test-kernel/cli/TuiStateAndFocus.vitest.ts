import '@test/support/defaultSessionTestSetup';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  activeRunId,
  beginWorkPlanReaderRequest,
  closeInfoPane,
  finishWorkPlanReaderRequest,
  focusRun,
  foregroundReader,
  infoPane,
  openInfoPane,
  rootRunPending,
  claimedRunId,
  resetCliState,
  setTransientNotice,
  transientNotice,
  expandedRuns,
  sessionListRows,
  sessionListRunIds,
} from '@cli/chat/tui/state/cliState';
import {
  allocateConversationPanelRows,
  allocateMiddleRows,
  shouldShowTodosPlanPanel,
  staticTranscriptRowBudget,
} from '@cli/chat/tui/appLayout';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStopActiveRun,
  chatTuiCanStopVisibleRun,
  chatTuiCanStartRootRun,
  chatTuiCanSelectModel,
  chatTuiSigintAction,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { focusedChildAcceptsFollowUps } from '@cli/chat/tui/state/sessionView';
import { resolveChildListTarget } from '@cli/chat/tui/state/childControls';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  MESSAGE_TYPES,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  TODO_STATUS,
  type ActiveChildInfo,
  type RunId,
  type ExtendedTokenUsageStats,
  type Plan,
  type RunIdentity,
  type RunPhase,
  type TodoItem,
  type UserFollowUpSupport,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const root = 'root' as RunId;
const child1 = 'child-1' as RunId;
const child2 = 'child-2' as RunId;
const grandchild = 'grandchild-1' as RunId;

/** A root with two children created in name order, the second of which has
 *  one child. */
function familyView(over: Partial<Record<RunId, Partial<RunView>>> = {}) {
  const ancestorsOf = (...ids: RunId[]) => ids.map((id) => ({ id, label: id }));
  return viewWith([
    makeRunView({ id: root, createdAt: 1, ...over[root] }),
    makeRunView({
      id: child1,
      createdAt: 2,
      parentId: root,
      ancestors: ancestorsOf(root),
      ...over[child1],
    }),
    makeRunView({
      id: child2,
      createdAt: 3,
      parentId: root,
      ancestors: ancestorsOf(root),
      ...over[child2],
    }),
    makeRunView({
      id: grandchild,
      createdAt: 4,
      parentId: child2,
      ancestors: ancestorsOf(root, child2),
      ...over[grandchild],
    }),
  ]);
}

describe('focus over the session view', () => {
  beforeAll(bindTestSessionView);

  it('keeps keyboard order identical to the grouped, expanded tree', () => {
    resetCliState();
    seedView(familyView({ [child2]: { forceExpanded: true } }));
    expect(sessionListRunIds.get()).toEqual([root]);
    expandedRuns.set(new Map([[root, true]]));
    expect(sessionListRunIds.get()).toEqual([root, child2, grandchild, child1]);
    expandedRuns.set(
      new Map([
        [root, true],
        [child2, false],
      ]),
    );
    expect(sessionListRunIds.get()).toEqual([root, child2, grandchild, child1]);
    expect(
      sessionListRows
        .get()
        .filter((row) => row.kind === 'group')
        .map((row) => row.label),
    ).toEqual(['Running']);
    resetCliState();
    expect(sessionListRunIds.get()).toEqual([root]);
  });

  it('resolves the child list to the nearest ancestor with children', () => {
    const view = familyView();
    expect(resolveChildListTarget(view, child1)).toBe(root);
    expect(resolveChildListTarget(view, child2)).toBe(child2);
    expect(resolveChildListTarget(view, grandchild)).toBe(child2);
    expect(resolveChildListTarget(view, undefined)).toBeUndefined();
  });

  it('routes composer follow-ups only to in-flight plain tool-use children', () => {
    const view = familyView({
      [child1]: { status: RUN_PHASE.COMPLETED },
      [child2]: { identity: { kind: 'process', tool: 'bash' } },
    });
    const stream = (id: RunId): RunView => {
      const found = view.runs.get(id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    };
    expect(focusedChildAcceptsFollowUps(stream(grandchild))).toBe(true);
    expect(focusedChildAcceptsFollowUps(stream(child1))).toBe(false);
    expect(focusedChildAcceptsFollowUps(stream(child2))).toBe(false);
  });
});

describe('cliState surface fields', () => {
  it('preserves multiple reference results until each is dismissed', () => {
    openInfoPane('/memory list', 'first\r\nresult');
    openInfoPane('/memory preview', 'second result');

    expect(infoPane.get()).toEqual({
      title: '/memory list',
      lines: ['first', 'result'],
    });
    closeInfoPane();
    expect(infoPane.get()).toEqual({
      title: '/memory preview',
      lines: ['second result'],
    });
  });

  it('normalizes transient notices to the status bar single-line contract', () => {
    setTransientNotice('Usage: /login target\n       /login chatgpt --device');

    expect(transientNotice.get()).toMatchObject({
      kind: 'message',
      text: 'Usage: /login target · /login chatgpt --device',
    });
  });
});

describe('CLI TUI row allocation', () => {
  it.each([
    {
      name: 'keeps foreground approval and form surfaces inside the middle row budget',
      options: {
        foregroundOpen: true,
        reverseSearchOpen: false,
        rows: 24,
        slashPaletteOpen: false,
      },
      transcriptRows: 1,
      foregroundRows: 18,
    },
    {
      name: 'returns disabled input rows to tiny foreground surfaces',
      options: {
        foregroundOpen: true,
        inputVisible: false,
        reverseSearchOpen: false,
        rows: 10,
        slashPaletteOpen: false,
      },
      transcriptRows: 1,
      foregroundRows: 7,
    },
    {
      name: 'can cap compact foreground surfaces on tall terminals',
      options: {
        foregroundMaxRows: 12,
        foregroundOpen: true,
        reverseSearchOpen: false,
        rows: 40,
        slashPaletteOpen: false,
      },
      transcriptRows: 1,
      foregroundRows: 12,
    },
    {
      name: 'uses the whole middle region for the transcript without foreground UI',
      options: {
        foregroundOpen: false,
        reverseSearchOpen: false,
        rows: 24,
        slashPaletteOpen: false,
      },
      transcriptRows: 19,
      foregroundRows: 0,
    },
    {
      name: 'reserves queued follow-up panel rows above the stable input chrome',
      options: {
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        reverseSearchOpen: false,
        rows: 24,
        slashPaletteOpen: false,
      },
      transcriptRows: 16,
      foregroundRows: 0,
    },
    {
      name: 'accounts for capped static transcript rows above the stable input chrome',
      options: {
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        reverseSearchOpen: false,
        rows: 10,
        slashPaletteOpen: false,
        staticTranscriptRows: 2,
      },
      transcriptRows: 0,
      foregroundRows: 0,
    },
  ])('$name', ({ options, transcriptRows, foregroundRows }) => {
    const layout = allocateMiddleRows(options);

    expect(layout.transcriptRows).toBe(transcriptRows);
    expect(layout.foregroundRows).toBe(foregroundRows);
  });

  it.each([
    {
      name: 'reserves rows for reverse-search input chrome',
      options: {
        foregroundOpen: false,
        reverseSearchOpen: true,
        rows: 24,
        slashPaletteOpen: false,
      },
      transcriptRows: 14,
      foregroundRows: 0,
    },
    {
      name: 'returns former header rows to the transcript when slash palette is open',
      options: {
        foregroundOpen: false,
        reverseSearchOpen: false,
        rows: 24,
        slashPaletteOpen: true,
      },
      transcriptRows: 6,
      foregroundRows: 0,
    },
  ])('$name', ({ options, transcriptRows, foregroundRows }) => {
    const layout = allocateMiddleRows(options);

    expect(layout.transcriptRows).toBe(transcriptRows);
    expect(layout.foregroundRows).toBe(foregroundRows);
  });

  const openTodo = {
    content: 'Check the live proof',
    activeForm: 'Checking the live proof',
    status: TODO_STATUS.IN_PROGRESS,
  } satisfies TodoItem;

  it.each([
    {
      name: 'before the stream resolves',
      runCompleted: false,
      runPromise: Promise.resolve(),
      runId: undefined,
      expected: false,
    },
    {
      name: 'while startup is pending',
      runCompleted: false,
      runPromise: undefined,
      runId: root,
      expected: false,
    },
    {
      name: 'after the run completed',
      runCompleted: true,
      runPromise: Promise.resolve(),
      runId: root,
      expected: false,
    },
    {
      name: 'with the stream resolved and the run in flight',
      runCompleted: false,
      runPromise: Promise.resolve(),
      runId: root,
      expected: true,
    },
  ])(
    'only reports a chat run interruptible $name',
    ({ runCompleted, runPromise, runId, expected }) => {
      expect(
        chatTuiCanInterruptActiveRun({ runCompleted, runPromise, runId }),
      ).toBe(expected);
    },
  );

  it('marks a chat root run pending before async startup work resolves', () => {
    const startupPromise = new Promise<void>(() => {});
    const session = new TuiSession();
    session.runId = root;
    session.runExitCode = CliExitCode.AgentError;
    session.markRunCompleted();
    session.stopRequested = true;

    session.markRunPending(startupPromise);

    expect(session.runId).toBeUndefined();
    expect(session.runPromise).toBe(startupPromise);
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);
    expect(rootRunPending.get()).toBe(true);
    expect(claimedRunId.get()).toBeUndefined();
  });

  it('publishes the run-control run id from the session itself', () => {
    const session = new TuiSession();
    session.markRunPending(new Promise<void>(() => {}));
    expect(claimedRunId.get()).toBeUndefined();

    // No publish call accompanies this write: the session owns the mirror,
    // so a caller cannot leave the Ctrl-C hint reading a stale claim (#8273).
    session.runId = root;

    expect(claimedRunId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(true);

    session.markRunCompleted();

    expect(claimedRunId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(false);
  });

  it('clears stale resume ids when clearing chat session run state', () => {
    const session = new TuiSession();
    session.markRunPending(Promise.resolve());
    session.markRunCompleted();
    session.runId = root;
    session.interruptedRunId = root;
    session.runExitCode = CliExitCode.Interrupted;
    session.stopRequested = true;

    session.clearRunState();

    expect(session.runId).toBeUndefined();
    expect(session.interruptedRunId).toBeUndefined();
    expect(session.runPromise).toBeUndefined();
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
  });
});
