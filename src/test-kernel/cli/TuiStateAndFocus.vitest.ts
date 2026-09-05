import '@test/support/defaultSessionTestSetup';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  activeStreamId,
  beginWorkPlanReaderRequest,
  closeInfoPane,
  finishWorkPlanReaderRequest,
  focusStream,
  foregroundReader,
  infoPane,
  openInfoPane,
  rootRunPending,
  rootRunStreamId,
  rootStreamId,
  resetCliState,
  setTransientNotice,
  transientNotice,
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
import {
  numericFocusTargetForActiveStream,
  resolveChildListTarget,
} from '@cli/chat/tui/state/childControls';
import { focusTreeOf } from '@cli/chat/tui/state/sessionView';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  MESSAGE_TYPES,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  TODO_STATUS,
  type ActiveChildInfo,
  type ExecutionId,
  type ExtendedTokenUsageStats,
  type Plan,
  type RunIdentity,
  type StreamPhase,
  type StreamTabId,
  type TodoItem,
  type UserFollowUpSupport,
} from '@shared/schemas';
import type { StreamView } from '@shared/session/sessionView';
import {
  bindTestSessionView,
  makeStreamView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const root = 'root' as StreamTabId;
const child1 = 'child-1' as StreamTabId;
const child2 = 'child-2' as StreamTabId;
const grandchild = 'grandchild-1' as StreamTabId;

/** A root with two children created in name order, the second of which has
 *  one child. */
function familyView(
  over: Partial<Record<StreamTabId, Partial<StreamView>>> = {},
) {
  const ancestorsOf = (...ids: StreamTabId[]) =>
    ids.map((id) => ({ id, label: id }));
  return viewWith([
    makeStreamView({ id: root, createdAt: 1, ...over[root] }),
    makeStreamView({
      id: child1,
      createdAt: 2,
      parentId: root,
      ancestors: ancestorsOf(root),
      ...over[child1],
    }),
    makeStreamView({
      id: child2,
      createdAt: 3,
      parentId: root,
      ancestors: ancestorsOf(root),
      ...over[child2],
    }),
    makeStreamView({
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

  it('orders the focus tree root first, then its children newest first', () => {
    const view = familyView();
    seedView(view);
    expect(focusTreeOf(view, root)).toEqual([root, child2, child1]);
    expect(focusTreeOf(view, child2)).toEqual([child2, grandchild]);
    expect(numericFocusTargetForActiveStream(view, root, 0)).toBe(child2);
    expect(numericFocusTargetForActiveStream(view, root, 1)).toBe(child1);
    expect(numericFocusTargetForActiveStream(view, root, 2)).toBeUndefined();
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
      [child1]: { status: STREAM_PHASE.COMPLETED },
      [child2]: { identity: { kind: 'process', tool: 'bash' } },
    });
    const stream = (id: StreamTabId): StreamView => {
      const found = view.streams.get(id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    };
    expect(focusedChildAcceptsFollowUps(stream(grandchild))).toBe(true);
    expect(focusedChildAcceptsFollowUps(stream(child1))).toBe(false);
    expect(focusedChildAcceptsFollowUps(stream(child2))).toBe(false);
  });
});

describe('cliState surface fields', () => {
  it('clears foreground reference text with the session state', () => {
    openInfoPane('/help', 'reference text');
    expect(infoPane.get()).toBeDefined();

    resetCliState();

    expect(infoPane.get()).toBeUndefined();
  });

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

  it('caps static transcript rows only in compact layouts', () => {
    expect(
      staticTranscriptRowBudget({
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 10,
      }),
    ).toBe(0);
    expect(
      staticTranscriptRowBudget({
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 14,
      }),
    ).toBe(4);
    expect(
      staticTranscriptRowBudget({
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 24,
      }),
    ).toBeUndefined();
  });

  it('keeps the compact live reserve aligned with pinned chrome', () => {
    const staticRows = staticTranscriptRowBudget({
      footerRows: 5,
      foregroundOpen: false,
      queuedFollowUpPanelRows: 3,
      rows: 14,
    });

    expect(staticRows).toBe(4);
    expect(
      allocateMiddleRows({
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        reverseSearchOpen: false,
        rows: 14,
        slashPaletteOpen: false,
        staticTranscriptRows: staticRows,
      }).transcriptRows,
    ).toBe(2);
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

  it.each([
    {
      transcriptRows: 1,
      expected: {
        bottomPanelRows: 0,
        conversationRows: 1,
        sessionPanelRows: 0,
        todosPlanRows: 0,
      },
    },
    {
      transcriptRows: 2,
      expected: {
        bottomPanelRows: 0,
        conversationRows: 2,
        sessionPanelRows: 0,
        todosPlanRows: 0,
      },
    },
    {
      transcriptRows: 3,
      expected: {
        bottomPanelRows: 2,
        conversationRows: 1,
        sessionPanelRows: 2,
        todosPlanRows: 0,
      },
    },
    // The focused list takes its full content (4 sessions + separator) and
    // never shares the panel with todos, which hide while it has focus.
    {
      transcriptRows: 8,
      expected: {
        bottomPanelRows: 5,
        conversationRows: 3,
        sessionPanelRows: 5,
        todosPlanRows: 0,
      },
    },
  ])(
    'reserves a live conversation row with $transcriptRows transcript rows',
    ({ transcriptRows, expected }) => {
      expect(
        allocateConversationPanelRows({
          maxRows: 10,
          sessionCount: 4,
          childListFocused: true,
          todosPlanContentRows: 2,
          transcriptRows,
        }),
      ).toEqual(expected);
    },
  );

  it('hides the child list when its gap and content cannot both fit', () => {
    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: false,
        todosPlanContentRows: 5,
        transcriptRows: 2,
      }),
    ).toEqual({
      conversationRows: 2,
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 1,
        childListFocused: true,
        todosPlanContentRows: 0,
        transcriptRows: 2,
      }),
    ).toEqual({
      conversationRows: 2,
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });

    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 3,
        childListFocused: true,
        minimumSessionPanelRows: 3,
        todosPlanContentRows: 0,
        transcriptRows: 3,
      }),
    ).toEqual({
      conversationRows: 3,
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  it('keeps the child list collapsed until it receives focus', () => {
    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: false,
        todosPlanContentRows: 0,
        transcriptRows: 7,
      }),
    ).toEqual({
      conversationRows: 7,
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });

    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: true,
        todosPlanContentRows: 0,
        transcriptRows: 7,
      }),
    ).toEqual({
      conversationRows: 4,
      bottomPanelRows: 3,
      sessionPanelRows: 3,
      todosPlanRows: 0,
    });
  });

  it('reserves a separator row above the todos panel', () => {
    // 2 todos + separator = 3 rows when the transcript allows it.
    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 0,
        childListFocused: false,
        todosPlanContentRows: 2,
        transcriptRows: 9,
      }),
    ).toMatchObject({ bottomPanelRows: 3, todosPlanRows: 3 });
  });

  it('hands a lone todos row back instead of rendering a dead separator', () => {
    // The grant would be exactly one row, too small for separator + content.
    const allocation = allocateConversationPanelRows({
      maxRows: 10,
      sessionCount: 0,
      childListFocused: false,
      todosPlanContentRows: 4,
      transcriptRows: 3,
    });
    expect(allocation).toEqual({
      conversationRows: 3,
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  it('does not allocate session rows without transcript space', () => {
    expect(
      allocateConversationPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: false,
        todosPlanContentRows: 5,
        transcriptRows: 1,
      }),
    ).toEqual({
      conversationRows: 1,
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  const openTodo = {
    content: 'Check the live proof',
    activeForm: 'Checking the live proof',
    status: TODO_STATUS.IN_PROGRESS,
  } satisfies TodoItem;

  it.each([
    {
      name: 'an open todo with no plan',
      foregroundOpen: false,
      hasPlan: false,
      todos: [openTodo],
      expected: true,
    },
    {
      name: 'a plan with no open todos',
      foregroundOpen: false,
      hasPlan: true,
      todos: [],
      expected: true,
    },
    {
      name: 'the foreground open',
      foregroundOpen: true,
      hasPlan: false,
      todos: [openTodo],
      expected: false,
    },
    {
      name: 'no todo or plan',
      foregroundOpen: false,
      hasPlan: false,
      todos: [],
      expected: false,
    },
    {
      name: 'a plan with only completed todos',
      foregroundOpen: false,
      hasPlan: true,
      todos: [
        {
          content: 'Finish the old goal',
          activeForm: 'Finishing the old goal',
          status: TODO_STATUS.COMPLETED,
        },
      ],
      expected: true,
    },
    {
      name: 'the child list focused',
      childListFocused: true,
      foregroundOpen: false,
      hasPlan: true,
      todos: [openTodo],
      expected: false,
    },
  ])(
    'keeps unfinished todo and plan chrome across stream phases: $name',
    ({
      childListFocused = false,
      foregroundOpen,
      hasPlan,
      todos,
      expected,
    }) => {
      expect(
        shouldShowTodosPlanPanel({
          childListFocused,
          foregroundOpen,
          hasPlan,
          todos,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: 'before the stream resolves',
      runCompleted: false,
      runPromise: Promise.resolve(),
      streamId: undefined,
      expected: false,
    },
    {
      name: 'while startup is pending',
      runCompleted: false,
      runPromise: undefined,
      streamId: root,
      expected: false,
    },
    {
      name: 'after the run completed',
      runCompleted: true,
      runPromise: Promise.resolve(),
      streamId: root,
      expected: false,
    },
    {
      name: 'with the stream resolved and the run in flight',
      runCompleted: false,
      runPromise: Promise.resolve(),
      streamId: root,
      expected: true,
    },
  ])(
    'only reports a chat run interruptible $name',
    ({ runCompleted, runPromise, streamId, expected }) => {
      expect(
        chatTuiCanInterruptActiveRun({ runCompleted, runPromise, streamId }),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: 'with no run pending',
      runCompleted: false,
      runPromise: undefined,
      expected: true,
    },
    {
      name: 'while a run is pending',
      runCompleted: false,
      runPromise: Promise.resolve(),
      expected: false,
    },
    {
      name: 'after a terminal chat failure',
      runCompleted: true,
      runPromise: Promise.resolve(),
      expected: true,
    },
  ])(
    'allows a fresh root run $name',
    ({ runCompleted, runPromise, expected }) => {
      expect(chatTuiCanStartRootRun({ runCompleted, runPromise })).toBe(
        expected,
      );
    },
  );

  it('marks a chat root run pending before async startup work resolves', () => {
    const startupPromise = new Promise<void>(() => {});
    const session = new TuiSession();
    session.streamId = root;
    session.executionId = 'exec-old';
    session.runExitCode = CliExitCode.AgentError;
    session.markRunCompleted();
    session.stopRequested = true;

    session.markRunPending(startupPromise);

    expect(session.streamId).toBeUndefined();
    expect(session.executionId).toBe('exec-old');
    expect(session.runPromise).toBe(startupPromise);
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);
    expect(rootRunPending.get()).toBe(true);
    expect(rootRunStreamId.get()).toBeUndefined();
  });

  it('publishes the run-control stream id from the session itself', () => {
    const session = new TuiSession();
    session.markRunPending(new Promise<void>(() => {}));
    expect(rootRunStreamId.get()).toBeUndefined();

    // No publish call accompanies this write: the session owns the mirror,
    // so a caller cannot leave the Ctrl-C hint reading a stale claim (#8273).
    session.streamId = root;

    expect(rootRunStreamId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(true);

    session.markRunCompleted();

    expect(rootRunStreamId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(false);
  });

  it('restores root run availability when clearing session run state', () => {
    const startupPromise = new Promise<void>(() => {});
    const session = new TuiSession();
    session.streamId = root;
    session.executionId = 'exec-old';
    session.runExitCode = CliExitCode.AgentError;
    session.stopRequested = true;
    session.markRunPending(startupPromise);

    session.clearRunState();

    expect(chatTuiCanStartRootRun(session)).toBe(true);
    expect(rootRunPending.get()).toBe(false);
    expect(rootRunStreamId.get()).toBeUndefined();
  });

  it('clears stale resume ids when clearing chat session run state', () => {
    const session = new TuiSession();
    session.markRunPending(Promise.resolve());
    session.markRunCompleted();
    session.streamId = root;
    session.interruptedStreamId = root;
    session.executionId = 'old-execution';
    session.runExitCode = CliExitCode.Interrupted;
    session.stopRequested = true;

    session.clearRunState();

    expect(session.streamId).toBeUndefined();
    expect(session.interruptedStreamId).toBeUndefined();
    expect(session.executionId).toBeUndefined();
    expect(session.runPromise).toBeUndefined();
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
  });
});
