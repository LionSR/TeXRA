// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Phase 4 state + focus-cycle smoke.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunTrace } from '@transcript';
import { clearAllStreamStatusesForTest } from '@test/helpers/streamStatusTestUtils';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  activeStreamId,
  rootRunPending,
  rootRunStartAvailable,
  rootRunStreamId,
  rootStreamId,
  removeStream,
  resetCliState,
  patchStream,
  setStreamStatusInCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import {
  allocateConversationBottomPanelRows,
  allocateMiddleRows,
  allocateSidePanelRows,
  shouldShowTipRow,
  shouldShowTodosPlanPanel,
  staticTranscriptRowBudget,
} from '@cli/chat/tui/appLayout';
import { orderedDescendantsFromTree } from '@cli/chat/tui/state/focusCycle';
import { hasChildControlItems } from '@cli/chat/tui/state/childControls';
import { focusedChildInputDisabledMessage } from '@cli/chat/tui/state/focusedChildFollowUp';
import {
  activeSubagentsFor,
  applySubagentRoster,
  childStreamEntries,
  isChildStreamRemoved,
  parentStream,
  retainedChildStreamsFor,
  setParentStream,
  visibleSubagentRows,
} from '@cli/chat/tui/state/childExecutions';
import {
  finalizeSettledPrefix,
  syncStreamLog,
} from '@cli/chat/tui/state/subscribeStreamLog';
import { transcriptViewportKey } from '@cli/chat/tui/state/transcriptViewportMode';
import { projectStreamTranscript } from '@cli/chat/tui/state/transcriptProjection';
import { subscribeStreamStatus } from '@cli/chat/tui/state/subscribeStreamStatus';
import { attachTuiRunFactSubscription } from '@cli/chat/tui/state/subscribeRuntimeHost';
import {
  COMPLETED_PROCESS_TAIL_LINES,
  buildCompletedProcessTranscript,
  completedProcessDisplayLines,
} from '@cli/chat/tui/state/completedProcessTranscript';
import { isChildExecutionErrorStatus } from '@cli/chat/tui/state/childExecutionStatus';
import {
  estimateTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from '@cli/chat/tui/panes/transcriptViewport';
import { splitTranscriptEntries } from '@cli/chat/tui/panes/transcriptEntries';
import { renderAnsiMarkdown } from '@cli/chat/tui/render/ansiMarkdown';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStopActiveRun,
  chatTuiCanStopVisibleRun,
  chatTuiCanStartRootRun,
  chatTuiCanSelectModel,
  chatTuiSigintAction,
  clearTuiSessionRunState,
  markChatTuiRunPending,
} from '@cli/chat/tui/state/sessionRunState';
import { chatTuiFocusedChildFollowUpRoute } from '@cli/chat/tui/runChatTui';
import { CliExitCode } from '@cli/runtime/exitCodes';
import {
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
  clearLocalTranscript,
  CLI_LOCAL_STREAM_ID,
  moveLocalTranscriptToStream,
  resolveLocalTranscriptStreamId,
} from '@cli/chat/tui/state/transcript';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  MESSAGE_TYPES,
  STREAM_PHASE,
  TODO_STATUS,
  type ActiveChildInfo,
  type ExecutionId,
  type Plan,
  type StorageKey,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { stripOrchestratorFollowup } from '@shared/subagentFollowup';

const root = 'root' as StreamTabId;
const child1 = 'child-1' as StreamTabId;
const child2 = 'child-2' as StreamTabId;
const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

function orderedSessionDescendants(parent: StreamTabId): StreamTabId[] {
  return orderedDescendantsFromTree({
    parent,
    childStreamEntries: childStreamEntries.get(),
    streams: streams.get(),
  });
}

afterEach(() => {
  clearAllStreamStatusesForTest(defaultSession().status);
  resetCliState();
});

describe('cliState Phase 4 fields', () => {
  it('initialises every new slice with empty subagent/process/todo/plan/bypass defaults', () => {
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    const slice = streams.get().get(root);
    expect(slice).toBeDefined();
    expect(
      activeSubagentsFor(root, childStreamEntries.get(), streams.get()),
    ).toEqual([]);
    expect(slice?.activeProcesses).toEqual([]);
    expect(slice?.todos).toEqual([]);
    expect(slice?.plan).toBeNull();
    expect(slice?.processOutput.size).toBe(0);
    expect(slice?.bypass).toEqual({
      bash: false,
      toolEdit: false,
      superYolo: false,
    });
  });

  it('prunes parent edges when a stream is removed', () => {
    setParentStream(child1, root);
    setParentStream(child2, root);
    expect(parentStream.get().get(child1)).toBe(root);
    expect(parentStream.get().get(child2)).toBe(root);

    // Removing a child drops its own edge but leaves siblings intact.
    patchStream(child1, (s) => ({ ...s, status: 'running' }));
    removeStream(child1);
    expect(parentStream.get().has(child1)).toBe(false);
    expect(parentStream.get().get(child2)).toBe(root);

    // Removing the parent prunes every edge that pointed at it.
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    removeStream(root);
    expect(parentStream.get().has(child2)).toBe(false);
  });

  it('removes stale child rows when a stream is removed', () => {
    activeStreamId.set(root);
    // Roster-first (rule 3): registers both the retained history row and
    // active membership, then the explicit edge arrives.
    applySubagentRoster(root, [
      {
        kind: 'subagent',
        executionId: 'agent-1',
        agentName: 'critic',
        childStreamId: child1,
        status: STREAM_PHASE.RUNNING,
      },
    ]);
    setParentStream(child1, root);
    // Processes never own a stream tab, so an unrelated background process
    // must be untouched by removing child1's stream below.
    patchStream(root, (s) => ({
      ...s,
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'process-1',
          agentName: 'bash',
          status: STREAM_PHASE.RUNNING,
        },
      ],
    }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));

    expect(
      hasChildControlItems(
        root,
        childStreamEntries.get(),
        streams.get(),
        'tasks',
      ),
    ).toBe(true);
    expect(
      hasChildControlItems(
        root,
        childStreamEntries.get(),
        streams.get(),
        'subagents',
      ),
    ).toBe(true);
    expect(orderedSessionDescendants(root)[0]).toBe(child1);

    removeStream(child1);

    const parent = streams.get().get(root);
    expect(parent).toBeDefined();
    if (!parent) throw new Error('missing parent stream');
    expect(
      retainedChildStreamsFor(root, childStreamEntries.get(), streams.get()),
    ).toEqual([]);
    expect(
      activeSubagentsFor(root, childStreamEntries.get(), streams.get()),
    ).toEqual([]);
    // Unaffected: process-1 never referenced child1's stream.
    expect(parent.activeProcesses).toMatchObject([
      { executionId: 'process-1' },
    ]);
    expect(
      visibleSubagentRows(root, childStreamEntries.get(), streams.get()),
    ).toEqual([]);
    expect(isChildStreamRemoved(child1)).toBe(true);
    // Still true: the untouched process-1 counts as a task-mode item.
    expect(
      hasChildControlItems(
        root,
        childStreamEntries.get(),
        streams.get(),
        'tasks',
      ),
    ).toBe(true);
    expect(
      hasChildControlItems(
        root,
        childStreamEntries.get(),
        streams.get(),
        'subagents',
      ),
    ).toBe(false);
    expect(orderedSessionDescendants(root)[0]).toBeUndefined();
  });

  it('updates retained child rows when a failed subagent leaves the active list', () => {
    const dispose = subscribeStreamStatus();
    try {
      applySubagentRoster(root, [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'codex',
          childStreamId: child1,
          status: STREAM_PHASE.RUNNING,
        },
      ]);
      // A later, empty roster clears active membership; the retained row
      // survives and its status is read live from the child's own slice.
      applySubagentRoster(root, []);

      defaultSession().status.transition(
        child1,
        STREAM_PHASE.FAILED,
        'restart-repair',
      );

      expect(
        activeSubagentsFor(root, childStreamEntries.get(), streams.get()),
      ).toEqual([]);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.FAILED);
      expect(
        visibleSubagentRows(root, childStreamEntries.get(), streams.get()),
      ).toMatchObject([
        {
          kind: 'subagent',
          executionId: 'agent-1',
          childStreamId: child1,
          status: STREAM_PHASE.FAILED,
        },
      ]);
    } finally {
      dispose();
    }
  });

  it('treats a null-parent update as child promotion to top-level', () => {
    setParentStream(child1, root);
    expect(parentStream.get().get(child1)).toBe(root);

    setParentStream(child1, null);

    expect(parentStream.get().has(child1)).toBe(false);
  });

  it('registers subagent parent edges when active child rows arrive', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      activeStreamId.set(root);
      patchStream(child1, (s) => ({
        ...s,
        status: STREAM_PHASE.RUNNING,
      }));

      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          kind: 'subagents',
          parentStreamId: root,
          children: [
            {
              kind: 'subagent',
              executionId: 'agent-1',
              agentName: 'critic',
              childStreamId: child1,
              status: STREAM_PHASE.RUNNING,
            },
          ],
        },
      });

      expect(parentStream.get().get(child1)).toBe(root);
      expect(orderedSessionDescendants(root)[0]).toBe(child1);
      expect(
        transcriptViewportKey({
          activeStreamId: child1,
          parentStream: parentStream.get(),
        }),
      ).toBe(`scoped:${child1}`);
      expect(
        transcriptViewportKey({
          activeStreamId: root,
          parentStream: parentStream.get(),
          transcriptViewerStreamId: child1,
        }),
      ).toBe(`viewer:${child1}`);
    } finally {
      detach();
    }
  });
});

describe('CLI TUI row allocation', () => {
  it('keeps foreground approval and form surfaces inside the middle row budget', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: true,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
      tipVisible: false,
    });

    expect(layout.transcriptRows).toBe(1);
    expect(layout.foregroundRows).toBe(18);
  });

  it('hides the normal chat tip row while foreground surfaces own input', () => {
    expect(shouldShowTipRow({ foregroundOpen: false })).toBe(true);
    expect(
      shouldShowTipRow({ foregroundOpen: false, hasQueuedFollowUps: true }),
    ).toBe(false);
    expect(shouldShowTipRow({ foregroundOpen: true })).toBe(false);
  });

  it('returns disabled input rows to tiny foreground surfaces', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: true,
      inputVisible: false,
      reverseSearchOpen: false,
      rows: 10,
      slashPaletteOpen: false,
      tipVisible: false,
    });

    expect(layout.transcriptRows).toBe(1);
    expect(layout.foregroundRows).toBe(7);
  });

  it('can cap compact foreground surfaces on tall terminals', () => {
    const layout = allocateMiddleRows({
      foregroundMaxRows: 12,
      foregroundOpen: true,
      reverseSearchOpen: false,
      rows: 40,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(1);
    expect(layout.foregroundRows).toBe(12);
  });

  it('lets transcript viewers own the full foreground region', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: true,
      reserveTranscriptRows: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
      tipVisible: false,
    });

    expect(layout.transcriptRows).toBe(0);
    expect(layout.foregroundRows).toBe(19);
  });

  it('uses the whole middle region for the transcript without foreground UI', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(18);
    expect(layout.foregroundRows).toBe(0);
  });

  it('reserves queued follow-up panel rows above the stable input chrome', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      queuedFollowUpPanelRows: 3,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
      tipVisible: false,
    });

    expect(layout.transcriptRows).toBe(16);
    expect(layout.foregroundRows).toBe(0);
  });

  it('accounts for capped static transcript rows above the stable input chrome', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      queuedFollowUpPanelRows: 3,
      reverseSearchOpen: false,
      rows: 10,
      slashPaletteOpen: false,
      staticTranscriptRows: 2,
      tipVisible: false,
    });

    expect(layout.transcriptRows).toBe(0);
    expect(layout.foregroundRows).toBe(0);
  });

  it('caps static transcript rows only in compact layouts', () => {
    expect(
      staticTranscriptRowBudget({
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 10,
        tipVisible: false,
      }),
    ).toBe(0);
    expect(
      staticTranscriptRowBudget({
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 14,
        tipVisible: false,
      }),
    ).toBe(4);
    expect(
      staticTranscriptRowBudget({
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 24,
        tipVisible: false,
      }),
    ).toBeUndefined();
  });

  it('keeps the compact live reserve aligned with pinned chrome', () => {
    const staticRows = staticTranscriptRowBudget({
      footerRows: 5,
      foregroundOpen: false,
      queuedFollowUpPanelRows: 3,
      rows: 14,
      tipVisible: false,
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
        tipVisible: false,
      }).transcriptRows,
    ).toBe(2);
  });

  it('reserves rows for reverse-search input chrome', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: true,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(13);
    expect(layout.foregroundRows).toBe(0);
  });

  it('returns former header rows to the transcript when slash palette is open', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: true,
    });

    expect(layout.transcriptRows).toBe(5);
    expect(layout.foregroundRows).toBe(0);
  });

  it('sizes side panels to their content within the budget', () => {
    // Everything fits: each panel takes exactly its content (no dead rows).
    expect(
      allocateSidePanelRows({
        subagentContentRows: 3,
        todosPlanContentRows: 4,
        rows: 13,
      }),
    ).toEqual({ subagentRows: 3, todosPlanRows: 4 });

    // A lone panel takes only what it needs; the rest is the conversation's.
    expect(
      allocateSidePanelRows({
        subagentContentRows: 0,
        todosPlanContentRows: 4,
        rows: 13,
      }),
    ).toEqual({ subagentRows: 0, todosPlanRows: 4 });

    // Over budget, a lone panel is capped at the available rows.
    expect(
      allocateSidePanelRows({
        subagentContentRows: 0,
        todosPlanContentRows: 20,
        rows: 13,
      }),
    ).toEqual({ subagentRows: 0, todosPlanRows: 13 });

    // Over budget with both present: keep at least one row each, split the
    // remainder proportionally to need.
    expect(
      allocateSidePanelRows({
        subagentContentRows: 10,
        todosPlanContentRows: 10,
        rows: 13,
      }),
    ).toEqual({ subagentRows: 7, todosPlanRows: 6 });

    // A single row with both present goes to the todos/plan panel.
    expect(
      allocateSidePanelRows({
        subagentContentRows: 5,
        todosPlanContentRows: 5,
        rows: 1,
      }),
    ).toEqual({ subagentRows: 0, todosPlanRows: 1 });
  });

  it('keeps sessions visible beside todos in a short terminal', () => {
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        processCount: 0,
        sessionCount: 2,
        sessionListFocused: false,
        todosPlanContentRows: 5,
        transcriptRows: 1,
      }),
    ).toEqual({
      bottomPanelRows: 1,
      sessionPanelRows: 1,
      todosPlanRows: 0,
    });
  });

  it('allocates session rows when process slice data is absent', () => {
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 2,
        sessionListFocused: false,
        todosPlanContentRows: 0,
        transcriptRows: 6,
      }),
    ).toEqual({
      bottomPanelRows: 2,
      sessionPanelRows: 2,
      todosPlanRows: 0,
    });
  });

  it('does not allocate session rows without transcript space', () => {
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 2,
        sessionListFocused: false,
        todosPlanContentRows: 5,
        transcriptRows: 0,
      }),
    ).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  it('shows todo and plan chrome only while a stream is active', () => {
    const openTodo = {
      content: 'Check the live proof',
      activeForm: 'Checking the live proof',
      status: TODO_STATUS.IN_PROGRESS,
    } satisfies TodoItem;
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        status: STREAM_PHASE.RUNNING,
        todos: [openTodo],
      }),
    ).toBe(true);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: true,
        status: STREAM_PHASE.RUNNING,
        todos: [],
      }),
    ).toBe(true);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        status: STREAM_PHASE.WAITING,
        todos: [openTodo],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        status: STREAM_PHASE.COMPLETED,
        todos: [openTodo],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: true,
        hasPlan: false,
        status: STREAM_PHASE.RUNNING,
        todos: [openTodo],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        status: STREAM_PHASE.RUNNING,
        todos: [],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: true,
        status: STREAM_PHASE.RUNNING,
        todos: [
          {
            content: 'Finish the old goal',
            activeForm: 'Finishing the old goal',
            status: TODO_STATUS.COMPLETED,
          },
        ],
      }),
    ).toBe(false);
  });

  it('only reports a chat run interruptible after stream resolution', () => {
    const runPromise = Promise.resolve();

    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: false,
        runPromise,
        streamId: undefined,
      }),
    ).toBe(false);
    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: false,
        runPromise: undefined,
        streamId: root,
      }),
    ).toBe(false);
    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: true,
        runPromise,
        streamId: root,
      }),
    ).toBe(false);
    expect(
      chatTuiCanInterruptActiveRun({
        runCompleted: false,
        runPromise,
        streamId: root,
      }),
    ).toBe(true);
  });

  it('allows a fresh root run after a terminal chat failure', () => {
    const runPromise = Promise.resolve();

    expect(
      chatTuiCanStartRootRun({
        runCompleted: false,
        runPromise: undefined,
      }),
    ).toBe(true);
    expect(
      chatTuiCanStartRootRun({
        runCompleted: false,
        runPromise,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStartRootRun({
        runCompleted: true,
        runPromise,
      }),
    ).toBe(true);
  });

  it('marks a chat root run pending before async startup work resolves', () => {
    const startupPromise = new Promise<void>(() => {});
    const session = {
      streamId: root,
      interruptedStreamId: undefined,
      executionId: 'exec-old',
      runPromise: undefined,
      runExitCode: CliExitCode.AgentError,
      runCompleted: true,
      stopRequested: true,
    };

    markChatTuiRunPending(session, startupPromise);

    expect(session.streamId).toBeUndefined();
    expect(session.executionId).toBe('exec-old');
    expect(session.runPromise).toBe(startupPromise);
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);
    expect(rootRunStartAvailable.get()).toBe(false);
    expect(rootRunPending.get()).toBe(true);
    expect(rootRunStreamId.get()).toBeUndefined();
  });

  it('restores root run availability when clearing session run state', () => {
    const startupPromise = new Promise<void>(() => {});
    const session = {
      streamId: root,
      interruptedStreamId: undefined,
      executionId: 'exec-old',
      runPromise: startupPromise,
      runExitCode: CliExitCode.AgentError,
      runCompleted: false,
      stopRequested: true,
    };
    markChatTuiRunPending(session, startupPromise);

    clearTuiSessionRunState(session);

    expect(chatTuiCanStartRootRun(session)).toBe(true);
    expect(rootRunStartAvailable.get()).toBe(true);
    expect(rootRunPending.get()).toBe(false);
    expect(rootRunStreamId.get()).toBeUndefined();
  });

  it('allows model selection before start or while a tool-use chat is waiting', () => {
    expect(
      chatTuiCanSelectModel({
        canStartRootRun: true,
        streamId: undefined,
        status: undefined,
        hasActiveToolUseFlow: false,
      }),
    ).toBe(true);
    expect(
      chatTuiCanSelectModel({
        canStartRootRun: false,
        streamId: root,
        status: STREAM_PHASE.WAITING,
        hasActiveToolUseFlow: true,
      }),
    ).toBe(true);
    expect(
      chatTuiCanSelectModel({
        canStartRootRun: false,
        streamId: root,
        status: STREAM_PHASE.RUNNING,
        hasActiveToolUseFlow: true,
      }),
    ).toBe(false);
    expect(
      chatTuiCanSelectModel({
        canStartRootRun: false,
        streamId: root,
        status: STREAM_PHASE.WAITING,
        hasActiveToolUseFlow: false,
      }),
    ).toBe(false);
  });

  it('only reports Ctrl-C stoppable while the root stream is actively responding', () => {
    expect(
      chatTuiCanStopActiveRun({
        runPending: true,
        streamId: undefined,
        status: undefined,
      }),
    ).toBe(true);
    expect(
      chatTuiCanStopActiveRun({
        runPending: true,
        streamId: root,
        status: STREAM_PHASE.RUNNING,
      }),
    ).toBe(true);
    expect(
      chatTuiCanStopActiveRun({
        runPending: true,
        streamId: root,
        status: STREAM_PHASE.WAITING,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun({
        runPending: true,
        streamId: root,
        status: STREAM_PHASE.FAILED,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun({
        runPending: true,
        streamId: root,
        status: STREAM_PHASE.CANCELLED,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun({
        runPending: true,
        streamId: root,
        status: STREAM_PHASE.COMPLETED,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun({
        runPending: false,
        streamId: root,
        status: STREAM_PHASE.RUNNING,
      }),
    ).toBe(false);
  });

  it('keeps Ctrl-C stoppable when the visible stream is already live', () => {
    expect(
      chatTuiCanStopVisibleRun({
        runPending: false,
        streamId: root,
        status: STREAM_PHASE.RUNNING,
      }),
    ).toBe(true);
    expect(
      chatTuiCanStopVisibleRun({
        runPending: false,
        streamId: undefined,
        status: STREAM_PHASE.RUNNING,
      }),
    ).toBe(false);
    expect(
      chatTuiCanStopVisibleRun({
        runPending: false,
        streamId: root,
        status: STREAM_PHASE.WAITING,
      }),
    ).toBe(false);
  });

  it('resolves the TUI Ctrl-C action from armed, stoppable, and interruptible state', () => {
    expect(
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun: false,
        resumableIdle: false,
      }),
    ).toBe('clean-exit');

    expect(
      // Idle/WAITING (interruptible, not stoppable): exit WITHOUT interrupting
      // so the suspended tool-use flow record and terminal status survive.
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun: false,
        resumableIdle: true,
      }),
    ).toBe('preserve-exit');

    expect(
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun: true,
        resumableIdle: false,
      }),
    ).toBe('interrupt-and-arm-exit');

    expect(
      chatTuiSigintAction({
        exitArmed: true,
        canStopActiveRun: true,
        resumableIdle: false,
      }),
    ).toBe('force-exit');
  });

  it('selects the focused child stream as a follow-up target', () => {
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    setParentStream(child1, root);

    activeStreamId.set(root);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({ kind: 'none' });

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'accept',
      streamId: child1,
    });
  });

  it('ignores stale child row status when routing focused child follow-ups', () => {
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    applySubagentRoster(root, [
      {
        kind: 'subagent',
        executionId: 'child-exec-1',
        agentName: 'critic',
        childStreamId: child1,
        status: STREAM_PHASE.COMPLETED,
      },
    ]);
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    setParentStream(child1, root);

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'accept',
      streamId: child1,
    });
  });

  it('uses child slice status as a fallback for focused child follow-ups', () => {
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    applySubagentRoster(root, [
      {
        kind: 'subagent',
        executionId: 'child-exec-1',
        agentName: 'critic',
        childStreamId: child1,
        status: STREAM_PHASE.RUNNING,
      },
    ]);
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.CANCELLED }));
    setParentStream(child1, root);

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'reject',
      streamId: child1,
    });
  });

  it('explains disabled input when a focused child stream cannot accept follow-ups', () => {
    setParentStream(child1, root);

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: root,
        parentStream: parentStream.get(),
        status: STREAM_PHASE.COMPLETED,
      }),
    ).toBeUndefined();

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        status: undefined,
      }),
    ).toBeUndefined();

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        status: STREAM_PHASE.RUNNING,
      }),
    ).toBeUndefined();

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        shortcutModifierLabel: 'Esc',
        status: STREAM_PHASE.COMPLETED,
      }),
    ).toBe(
      'Subagent is no longer accepting follow-ups; press Tab to select a session or Esc s to choose another.',
    );

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        shortcutModifierLabel: 'Alt',
        status: STREAM_PHASE.COMPLETED,
      }),
    ).toBe(
      'Subagent is no longer accepting follow-ups; press Tab to select a session or Alt-s to choose another.',
    );

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        shortcutModifierLabel: 'Esc',
        status: STREAM_PHASE.COMPLETED,
        subagentControlsAvailable: false,
      }),
    ).toBe(
      'Subagent is no longer accepting follow-ups; press Tab to select a session.',
    );

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        shortcutModifierLabel: 'Esc',
        status: STREAM_PHASE.COMPLETED,
        subagentControlsAvailable: false,
        taskControlsAvailable: true,
      }),
    ).toBe(
      'Subagent is no longer accepting follow-ups; press Tab to select a session or Esc p to review tasks.',
    );

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        shortcutModifierLabel: 'Esc',
        status: STREAM_PHASE.COMPLETED,
        taskControlsAvailable: true,
      }),
    ).toBe(
      'Subagent is no longer accepting follow-ups; press Tab to select a session or Esc s to choose another, or Esc p to review tasks.',
    );
  });

  it('mirrors running child status events into focused child routing', () => {
    const dispose = subscribeStreamStatus();
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    applySubagentRoster(root, [
      {
        kind: 'subagent',
        executionId: 'child-exec-1',
        agentName: 'critic',
        childStreamId: child1,
        status: STREAM_PHASE.COMPLETED,
      },
    ]);
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.CANCELLED }));
    setParentStream(child1, root);

    try {
      defaultSession().status.transition(
        child1,
        STREAM_PHASE.RUNNING,
        'restart-repair',
      );

      activeStreamId.set(child1);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.RUNNING);
      expect(
        retainedChildStreamsFor(
          root,
          childStreamEntries.get(),
          streams.get(),
        )[0]?.status,
      ).toBe(STREAM_PHASE.RUNNING);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });
    } finally {
      dispose();
    }
  });

  it('mirrors stopped child status events into focused child routing', () => {
    const dispose = subscribeStreamStatus();
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    applySubagentRoster(root, [
      {
        kind: 'subagent',
        executionId: 'child-exec-1',
        agentName: 'critic',
        childStreamId: child1,
        status: STREAM_PHASE.RUNNING,
      },
    ]);
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    setParentStream(child1, root);

    try {
      defaultSession().status.transition(
        child1,
        STREAM_PHASE.CANCELLED,
        'restart-repair',
      );

      activeStreamId.set(child1);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.CANCELLED);
      expect(
        retainedChildStreamsFor(
          root,
          childStreamEntries.get(),
          streams.get(),
        )[0]?.status,
      ).toBe(STREAM_PHASE.CANCELLED);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'reject',
        streamId: child1,
      });
    } finally {
      dispose();
    }
  });

  it('clears stale resume ids when clearing chat session run state', () => {
    const session = {
      streamId: root,
      interruptedStreamId: root,
      executionId: 'old-execution',
      runPromise: Promise.resolve(),
      runExitCode: CliExitCode.Interrupted,
      runCompleted: true,
      stopRequested: true,
    };

    clearTuiSessionRunState(session);

    expect(session).toMatchObject({
      streamId: undefined,
      interruptedStreamId: undefined,
      executionId: undefined,
      runPromise: undefined,
      runExitCode: 0,
      runCompleted: false,
      stopRequested: false,
    });
  });
});

describe('finalizeSettledPrefix', () => {
  const tool = (id: string, status: 'in_progress' | 'completed') =>
    ({
      id,
      role: 'tool',
      text: '',
      finalized: false,
      toolUse: {
        parsed: {},
        toolName: 'Bash',
        errorText: '',
        outputText: '',
        userInstructionText: '',
        input: {},
        isError: false,
        isUserFeedback: false,
        headerSummary: '',
        status,
      },
    }) as const;
  const assistant = (id: string, pendingEmbeddedSubagentFollowup = false) =>
    ({
      id,
      role: 'assistant',
      text: id,
      ...(pendingEmbeddedSubagentFollowup
        ? { pendingEmbeddedSubagentFollowup }
        : {}),
      finalized: false,
    }) as const;
  const finalizedIds = (
    entries: readonly { id: string; finalized: boolean }[],
  ) => entries.filter((entry) => entry.finalized).map((entry) => entry.id);

  it('finalizes an assistant block once the model moves on to a tool call', () => {
    const out = finalizeSettledPrefix(
      [assistant('a1'), tool('t1', 'completed'), assistant('a2')],
      false,
    );
    // a1 settled (later entry exists), t1 settled (completed), a2 is the
    // live tail and stays pending.
    expect(finalizedIds(out)).toEqual(['a1', 't1']);
  });

  it('keeps the in-flight tail pending while the stream runs', () => {
    const out = finalizeSettledPrefix([assistant('a1')], false);
    expect(finalizedIds(out)).toEqual([]);
  });

  it('keeps assistant entries with incomplete subagent blocks pending', () => {
    const out = finalizeSettledPrefix(
      [assistant('a1', true), tool('t1', 'completed'), assistant('a2')],
      false,
    );

    expect(finalizedIds(out)).toEqual([]);
  });

  it('does not promote past a still-running tool (preserves Static order)', () => {
    const out = finalizeSettledPrefix(
      [assistant('a1'), tool('t1', 'in_progress'), tool('t2', 'completed')],
      false,
    );
    // t1 is still running: t2 must wait behind it even though it completed,
    // or it would print above t1 in append-only scrollback.
    expect(finalizedIds(out)).toEqual(['a1']);
  });

  it('finalizes every remaining entry once the stream reaches a final status', () => {
    const out = finalizeSettledPrefix(
      [assistant('a1'), tool('t1', 'in_progress'), assistant('a2')],
      true,
    );
    expect(finalizedIds(out)).toEqual(['a1', 't1', 'a2']);
  });

  it('returns the same entries when nothing newly settles', () => {
    const entries = [assistant('a1')];
    expect(finalizeSettledPrefix(entries, false)).toBe(entries);
  });
});

describe('CLI transcript state', () => {
  // Several tests below log through `createRunTrace`/`syncStreamLog`, which
  // read and write the default session's `transcripts` store. No separate
  // default-store export to swap in anymore (#7694) — clear it in place
  // before every test instead, so store-backed tests don't need to repeat
  // that reset individually.
  beforeEach(async () => {
    await defaultSession().transcripts.clear();
  });

  it('renders orchestrator follow-ups without protocol tags', () => {
    expect(
      stripOrchestratorFollowup(
        '<orchestrator-followup>\nPlease inspect the file.\n</orchestrator-followup>',
      ),
    ).toBe('Please inspect the file.');
    expect(stripOrchestratorFollowup('ordinary user text')).toBe(
      'ordinary user text',
    );
  });

  it('summarizes subagent protocol continuations in the visible transcript', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('Please solve the problem.', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    logger.info(
      '<subagent-result id="abc" agent="review" category="toolUse" status="completed">\nDone.\n</subagent-result>',
      { messageType: MESSAGE_TYPES.USER_MESSAGE },
    );

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'Please solve the problem.',
      '✓ review completed',
    ]);
  });

  it('summarizes embedded subagent progress blocks in assistant transcript text', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info(
      [
        'Waiting for the child.',
        '<subagent-progress id="abc" agent="prover" type="todos">',
        '[{"content":"check","status":"completed"},{"content":"prove","status":"in_progress"}]',
        '</subagent-progress>',
        '<subagent-progress id="abc" agent="prover" type="activity">Subagent prover is proving completeness.</subagent-progress>',
      ].join('\n'),
      { messageType: MESSAGE_TYPES.MODEL_RESPONSE },
    );

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      [
        'Waiting for the child.',
        '⟳ prover · todos · 1 done, 1 active, 0 pending',
        '⟳ prover · Subagent prover is proving completeness.',
      ].join('\n'),
    ]);
    expect(entries[0]?.text).not.toContain('<subagent-progress');
  });

  it('normalizes common HTML before assistant text reaches the live transcript', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info(
      '<h3>Verification Report</h3>The proof is <b>fully verified</b>.',
      { messageType: MESSAGE_TYPES.MODEL_RESPONSE },
    );

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      '### Verification Report\n\nThe proof is **fully verified**.',
    ]);
    expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.MODEL_RESPONSE);
    expect(entries[0]?.text).not.toContain('<h3>');
    expect(entries[0]?.text).not.toContain('<b>');
  });

  it('bounds long subagent result responses in the visible transcript', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    const response = Array.from(
      { length: 20 },
      (_, index) => `proof line ${index + 1}`,
    ).join('\n');
    logger.info(
      [
        '<subagent-result id="abc" agent="prover" category="toolUse" status="completed">',
        '<wall-time>2m</wall-time>',
        '<response>',
        response,
        '</response>',
        '</subagent-result>',
      ].join('\n'),
      { messageType: MESSAGE_TYPES.USER_MESSAGE },
    );

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toContain('✓ prover completed · 2m');
    expect(entries[0]?.text).toContain('proof line 12');
    expect(entries[0]?.text).not.toContain('proof line 13');
    expect(entries[0]?.text).toContain(
      '… 8 more lines; open the subagent transcript for the full response',
    );
    expect(entries[0]?.text).not.toContain('<subagent-result');
  });

  it('mirrors error log entries into the transcript', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.error('Model request failed', {
      messageType: MESSAGE_TYPES.ERROR,
    });

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'error',
      text: 'Model request failed',
      finalized: true,
    });
  });

  it('tracks hidden thinking activity without rendering thinking text', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    const thinking = logger.openStream(MESSAGE_TYPES.THINKING);

    // Opening the stream alone marks the phase — hidden reasoning (e.g.
    // gpt-5 without summaries) may never produce a text delta.
    syncStreamLog(root);

    let slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(true);
    expect(slice?.entries).toEqual([]);

    thinking.append('private reasoning summary');

    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(true);
    expect(slice?.entries).toEqual([]);

    thinking.finalize();
    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(false);
    expect(slice?.entries).toEqual([]);

    const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Visible answer.');

    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(false);
    expect(slice?.entries.map((entry) => entry.text)).toEqual([
      'Visible answer.',
    ]);
  });

  it('does not project empty assistant responses into transcript rows', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('', { messageType: MESSAGE_TYPES.MODEL_RESPONSE });

    syncStreamLog(root);

    let slice = streams.get().get(root);
    expect(slice?.entries ?? []).toEqual([]);

    logger.info('Visible answer.', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });

    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.entries.map((entry) => entry.text)).toEqual([
      'Visible answer.',
    ]);
  });

  it('trims leading blank assistant rows at turn start', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('Why?', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    logger.info('\n\n  The answer starts here.', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'Why?',
      '  The answer starts here.',
    ]);
  });

  // Regression: a sync tick that fires after `finalizeAssistantTranscriptEntries`
  // must not roll the entry back to `finalized: false`. Cursor Bugbot flagged
  // this when `entriesEqual` started comparing `finalized` — without this
  // guard, the de-finalized entry would land in neither bucket of
  // `splitTranscriptEntries` once status flipped to WAITING and silently
  // disappear from the transcript.
  it('preserves the finalized flag through a post-finalize sync tick', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('streaming assistant chunk', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    syncStreamLog(root);

    // Stream-level finalize promotes the deferred-finalization entries.
    patchStream(root, (slice) => ({
      ...slice,
      entries: slice.entries.map((entry) =>
        entry.role === 'assistant' ? { ...entry, finalized: true } : entry,
      ),
    }));

    // A second sync after finalize must not regress the flag.
    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      finalized: true,
    });
  });

  // #7086: the transcript store — not a CLI-side synthetic fallback — is now
  // the single source of the finalized assistant message. `responseFinalized`
  // is what `ToolUseProcessNode` calls at the turn boundary once
  // `assembly.lastResponse` is set (see TexraTranscriptRecorder.vitest.ts for
  // the recorder-level upsert-vs-append unit coverage); these tests confirm
  // the CLI's own state ends up with exactly one entry, never a synthetic one.
  it('reconciles a streamed response to the authoritative post-replacement text', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    // Raw provider text, as it would arrive before replacement rules run.
    output.append('Done ✓');
    output.finalize();
    // The flow boundary's authoritative (replacement-cleaned) text.
    logger.responseFinalized('Done \\checkmark');

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'Done \\checkmark',
    });
    expect(entries[0]?.synthetic).toBeUndefined();
  });

  it('appends the final response when the round produced no live stream', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.responseFinalized('The answer is 2.');

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'The answer is 2.',
    });
    expect(entries[0]?.synthetic).toBeUndefined();
  });

  it('does not let an earlier round leak its stream id into a later round', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    const round0 = logger.openStage('r0', { kind: 'round', index: 0 });
    const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Let me check that.');
    output.finalize();
    round0.end();

    // A later round that never streams must append its own entry rather
    // than reuse round 0's (now-closed) stream id.
    const round1 = logger.openStage('r1', { kind: 'round', index: 1 });
    logger.responseFinalized('Final answer.');
    round1.end();

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'Let me check that.',
      'Final answer.',
    ]);
    expect(entries.every((entry) => !entry.synthetic)).toBe(true);
  });

  it('projects a turn boundary from the store alone, with zero synthetic entries', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('What is 1 + 1?', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    logger.info('2', { messageType: MESSAGE_TYPES.MODEL_RESPONSE });

    projectStreamTranscript(root, { finalize: true });

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual(['What is 1 + 1?', '2']);
    expect(entries.map((entry) => entry.finalized)).toEqual([true, true]);
    expect(entries.every((entry) => !entry.synthetic)).toBe(true);
  });

  it('keeps repeated local slash-command responses visible', () => {
    activeStreamId.set(root);

    appendLocalAssistantTranscript('Available commands: /help');
    appendLocalAssistantTranscript('Available commands: /help');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'Available commands: /help',
      'Available commands: /help',
    ]);
  });

  it('preserves literal checkmark commands in local user transcript text', () => {
    activeStreamId.set(root);

    appendLocalUserTranscript('literal \\checkmark');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'literal \\checkmark'],
    ]);
  });

  it('can append local assistant output to an explicit stream', () => {
    activeStreamId.set(root);

    appendLocalAssistantTranscript('Child stream note.', child1);

    expect(streams.get().get(root)?.entries ?? []).toEqual([]);
    expect(
      streams
        .get()
        .get(child1)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['Child stream note.']);
  });

  it('keeps root local notices out of a focused child stream', () => {
    rootStreamId.set(root);
    setParentStream(child1, root);
    activeStreamId.set(child1);

    appendLocalAssistantTranscript('Available commands: /help');
    appendLocalErrorTranscript('Model claude-opus-4-7 not found');

    expect(
      streams
        .get()
        .get(root)
        ?.entries.map((entry) => [entry.role, entry.text]),
    ).toEqual([
      ['assistant', 'Available commands: /help'],
      ['error', 'Model claude-opus-4-7 not found'],
    ]);
    expect(streams.get().get(child1)?.entries ?? []).toEqual([]);
    expect(activeStreamId.get()).toBe(child1);
  });

  it('uses the focused child parent for local notices before root id is set', () => {
    setParentStream(child1, root);
    activeStreamId.set(child1);

    appendLocalAssistantTranscript('Slash command output.');

    expect(
      streams
        .get()
        .get(root)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['Slash command output.']);
    expect(streams.get().get(child1)?.entries ?? []).toEqual([]);
    expect(activeStreamId.get()).toBe(child1);
  });

  it('resolves root-owned local transcript targets before active children', () => {
    const parentStream = new Map([[child1, root]]);

    expect(
      resolveLocalTranscriptStreamId({
        activeStreamId: child1,
        fallbackStreamId: CLI_LOCAL_STREAM_ID,
        parentStream,
        rootStreamId: 'root-from-session' as StreamTabId,
      }),
    ).toBe('root-from-session');
    expect(
      resolveLocalTranscriptStreamId({
        activeStreamId: child1,
        fallbackStreamId: CLI_LOCAL_STREAM_ID,
        parentStream,
        rootStreamId: undefined,
      }),
    ).toBe(root);
    expect(
      resolveLocalTranscriptStreamId({
        activeStreamId: undefined,
        fallbackStreamId: CLI_LOCAL_STREAM_ID,
        parentStream,
        rootStreamId: undefined,
      }),
    ).toBe(CLI_LOCAL_STREAM_ID);
  });

  it('adds local runtime errors to the transcript', () => {
    activeStreamId.set(root);

    appendLocalErrorTranscript('Model claude-opus-4-7 not found');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'error',
      text: 'Model claude-opus-4-7 not found',
      finalized: true,
      synthetic: true,
      syntheticKind: 'local',
    });
  });

  it('flushes pending model-response chunks before transcript sync', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    stream.append('A short final answer.');

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'A short final answer.',
    ]);
  });

  it('finalizes a delayed first model-response sync after the stream is idle', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('A delayed final answer.', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    patchStream(root, (slice) => ({
      ...slice,
      status: STREAM_PHASE.WAITING,
    }));

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'A delayed final answer.',
      finalized: true,
    });
    const split = splitTranscriptEntries(entries, STREAM_PHASE.WAITING);
    expect(split.finalized.map((entry) => entry.id)).toEqual([entries[0]?.id]);
    expect(split.pending).toEqual([]);
  });

  it('keeps repeated local slash-command responses after stream-log syncs', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    activeStreamId.set(root);

    appendLocalAssistantTranscript('Available commands: /help');
    logger.info('partial response', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    syncStreamLog(root);

    appendLocalAssistantTranscript('Available commands: /help');
    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(
      entries
        .filter((entry) => entry.syntheticKind === 'local')
        .map((entry) => entry.text),
    ).toEqual(['Available commands: /help', 'Available commands: /help']);
  });

  it('keeps a model response live when local output follows it', () => {
    const { finalized, pending } = splitTranscriptEntries(
      [
        {
          id: 'model-response',
          role: 'assistant',
          text: 'partial',
          finalized: false,
        },
        {
          id: 'local-help',
          role: 'assistant',
          text: 'Available commands: /help',
          finalized: true,
          synthetic: true,
          syntheticKind: 'local',
          syntheticAfterSeq: 1,
        },
      ],
      STREAM_PHASE.RUNNING,
    );

    expect(pending.map((entry) => entry.id)).toEqual(['model-response']);
    expect(finalized.map((entry) => entry.id)).toEqual(['local-help']);
  });

  it('estimates finalized assistant rows from rendered markdown', () => {
    const text = ['A paragraph.', '', '- abcdef ghijkl mnopqr'].join('\n');
    const width = 10;
    const renderedRows = renderAnsiMarkdown(text, { width }).split('\n').length;
    const entry = {
      id: 'assistant-markdown',
      role: 'assistant',
      text,
      finalized: true,
    } as const;

    expect(estimateTranscriptEntryRows(entry, width)).toBe(renderedRows);
  });

  it('does not reserve spacer rows for compact one-line tool calls', () => {
    const entry = {
      id: 'empty-tool',
      role: 'tool',
      text: '',
      finalized: false,
      toolUse: {
        parsed: {},
        toolName: 'executions',
        errorText: '',
        outputText: '',
        userInstructionText: '',
        input: { path: '/executions/3a780a389327/report' },
        isError: false,
        isUserFeedback: false,
        headerSummary: '',
        status: 'completed',
      },
    } as const;

    expect(estimateTranscriptEntryRows(entry, 80)).toBe(1);
  });

  it('keeps pending transcript rows within their viewport budget', () => {
    const pending = [
      {
        id: 'assistant',
        role: 'assistant',
        text: 'streaming reply',
        finalized: false,
      },
      {
        id: 'tool',
        role: 'tool',
        text: '',
        finalized: false,
        toolUse: {
          parsed: {},
          toolName: 'Bash',
          errorText: '',
          outputText: 'one\ntwo\nthree',
          userInstructionText: '',
          input: { command: 'ls' },
          isError: false,
          isUserFeedback: false,
          headerSummary: '',
          status: 'completed',
        },
      },
    ] as const;

    const selected = selectTranscriptEntriesForViewport(pending, 3, 80);

    expect(selected.entries.map((entry) => entry.id)).toEqual(['tool']);
    expect(selected.rowLimits.get('tool')).toBe(3);
    expect(selected.usedRows).toBe(3);
  });

  it('lets live output fill the viewport instead of reserving a history marker row', () => {
    const pending = [
      {
        id: 'assistant',
        role: 'assistant',
        text: 'streaming reply '.repeat(300),
        finalized: false,
      },
    ] as const;

    const selected = selectTranscriptEntriesForViewport(pending, 13, 80);

    expect(selected.usedRows).toBe(13);
    expect(selected.entries.map((entry) => entry.id)).toEqual(['assistant']);
  });

  it('moves pre-session local slash-command output onto the resolved stream', () => {
    appendLocalAssistantTranscript('Available commands: /help');

    expect(streams.get().get(CLI_LOCAL_STREAM_ID)?.entries).toHaveLength(1);

    moveLocalTranscriptToStream(root);

    expect(streams.get().has(CLI_LOCAL_STREAM_ID)).toBe(false);
    expect(activeStreamId.get()).toBe(root);
    expect(
      streams
        .get()
        .get(root)
        ?.entries.map((entry) => entry.text),
    ).toEqual(['Available commands: /help']);
  });

  it('can discard pre-resume local slash-command output', () => {
    appendLocalAssistantTranscript('/resume exec-1');

    expect(activeStreamId.get()).toBe(CLI_LOCAL_STREAM_ID);
    expect(streams.get().get(CLI_LOCAL_STREAM_ID)?.entries).toHaveLength(1);

    clearLocalTranscript();

    expect(streams.get().has(CLI_LOCAL_STREAM_ID)).toBe(false);
    expect(activeStreamId.get()).toBeUndefined();
  });

  it('preserves the finalized response across later log syncs', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('1+1', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    logger.responseFinalized('The answer is 2.');

    logger.info('next prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      '1+1',
      'The answer is 2.',
      'next prompt',
    ]);
  });

  it('orders multiple finalized responses relative to the turns around them', () => {
    const logger = createRunTrace(root, defaultSession().transcripts).trace;
    logger.info('first prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    logger.responseFinalized('first answer');

    logger.info('second prompt', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    syncStreamLog(root);
    logger.responseFinalized('second answer');

    logger.info('third prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'first prompt',
      'first answer',
      'second prompt',
      'second answer',
      'third prompt',
    ]);
    expect(entries.every((entry) => !entry.synthetic)).toBe(true);
  });
});

describe('subscribeRuntimeHost.updateActiveProcesses', () => {
  const runningProcessA: ActiveChildInfo = {
    kind: 'process',
    executionId: 'exec-a',
    agentName: 'latexmk',
    toolName: 'bash',
    status: 'running',
  };
  const runningProcessB: ActiveChildInfo = {
    kind: 'process',
    executionId: 'exec-b',
    agentName: 'bash',
    status: 'running',
  };

  it('applies typed updateTodos run facts without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const todos: TodoItem[] = [
      {
        content: 'State the compactness lemma',
        status: TODO_STATUS.PENDING,
        activeForm: 'Stating the compactness lemma',
      },
    ];

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updateTodos',
          streamId: root,
          todos,
        },
      });

      expect(streams.get().get(root)?.todos).toEqual(todos);
    } finally {
      detach();
    }
  });

  it('applies typed updatePlan run facts without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const plan: Plan = {
      objective: 'Prove the local estimate and record the stopping criterion.',
    };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updatePlan',
          streamId: root,
          plan,
        },
      });

      expect(streams.get().get(root)?.plan).toEqual(plan);
    } finally {
      detach();
    }
  });

  it('applies typed goalPaused run facts without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'goalPaused',
          streamId: root,
        },
      });

      expect(
        streams
          .get()
          .get(root)
          ?.entries.map((entry) => entry.text),
      ).toEqual([GOAL_PAUSED_TRANSCRIPT_NOTICE]);
    } finally {
      detach();
    }
  });

  it('applies direct stage.start(kind: round) events without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'stage.start',
          id: 'round-2',
          label: 'Round 2',
          kind: 'round',
          index: 1,
          total: 3,
        },
      });

      expect(streams.get().get(root)?.roundStage).toEqual({
        index: 1,
        total: 3,
      });
    } finally {
      detach();
    }
  });

  it('ignores direct non-round stage.start events without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'stage.start',
          id: 'phase-1',
          label: 'Compile phase',
          kind: 'phase',
          index: 0,
        },
      });

      expect(streams.get().get(root)?.roundStage).toBeUndefined();
    } finally {
      detach();
    }
  });

  it('applies direct child activity and parent-link facts without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const child: ActiveChildInfo = {
      kind: 'subagent',
      executionId: 'agent-1',
      agentName: 'critic',
      childStreamId: child1,
      status: STREAM_PHASE.RUNNING,
    };

    try {
      // The child's own status is the single owner the roster selectors read
      // from (rule 8: the roster's copied status is discarded).
      patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          kind: 'subagents',
          parentStreamId: root,
          children: [child],
        },
      });
      hub.emit({
        scope: 'session',
        event: {
          type: 'setParentStream',
          payload: {
            childStreamId: child2,
            parentStreamId: root,
          },
        },
      });

      expect(
        activeSubagentsFor(root, childStreamEntries.get(), streams.get()),
      ).toEqual([child]);
      expect(
        retainedChildStreamsFor(root, childStreamEntries.get(), streams.get()),
      ).toEqual([child]);
      expect(parentStream.get().get(child1)).toBe(root);
      expect(parentStream.get().get(child2)).toBe(root);
    } finally {
      detach();
    }
  });

  it('applies direct process.output events without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'process.output',
          parentStreamId: root,
          executionId: 'exec-a',
          stdout: 'stdout chunk',
          stderr: 'stderr chunk',
        },
      });

      expect(streams.get().get(root)?.processOutput.get('exec-a')).toEqual({
        stdout: 'stdout chunk',
        stderr: 'stderr chunk',
      });
    } finally {
      detach();
    }
  });

  it('applies direct child.activity(processes) completion and prunes output once', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId: root,
          processes: [runningProcessA, runningProcessB],
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'process.output',
          parentStreamId: root,
          executionId: 'exec-a',
          stdout: 'done line',
          stderr: '',
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'process.output',
          parentStreamId: root,
          executionId: 'exec-b',
          stdout: 'still running',
          stderr: '',
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId: root,
          processes: [runningProcessB],
        },
      });

      const slice = streams.get().get(root);
      expect(slice?.activeProcesses).toEqual([runningProcessB]);
      expect(slice?.processOutput.has('exec-a')).toBe(false);
      expect(slice?.processOutput.get('exec-b')).toEqual({
        stdout: 'still running',
        stderr: '',
      });
      expect(
        slice?.entries.filter((entry) => entry.role === 'process'),
      ).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('applies direct usage events without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const storageKey = 'root-direct-run' as StorageKey;
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cost: 1,
      cacheReadInputTokens: 30,
      elapsedTime: 1.5,
      percentageCached: 25,
      reasoningTokens: 7,
    };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'usage',
          stats: usage,
          data: {
            streamId: root,
            storageKey,
            executionId: 'exec-direct',
            usage,
          },
        },
      });

      expect(streams.get().get(root)?.usage).toEqual(usage);
      expect(streams.get().get(root)?.cumulativeUsage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cost: 1,
        cacheReadInputTokens: 30,
        cacheMissInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 7,
      });
    } finally {
      detach();
    }
  });

  it('applies direct session stream facts without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      activeStreamId.set(root);
      hub.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: child1,
            suppressViewSwitch: true,
            agentCategory: AgentCategory.ToolUse,
          },
        },
      });
      hub.emit({
        scope: 'session',
        event: {
          type: 'updateStreamDescription',
          payload: {
            streamId: child1,
            description: 'Checking the local compactness claim.',
          },
        },
      });

      expect(activeStreamId.get()).toBe(root);
      expect(streams.get().get(child1)).toMatchObject({
        category: AgentCategory.ToolUse,
        description: 'Checking the local compactness claim.',
      });

      hub.emit({
        scope: 'session',
        event: {
          type: 'removeStream',
          payload: { streamId: child1 },
        },
      });

      expect(streams.get().has(child1)).toBe(false);
    } finally {
      detach();
    }
  });

  it('applies direct run config and conversation progress without host emission', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'run.config',
          streamId: root,
          executionId: 'exec-config' as ExecutionId,
          config: {
            agent: 'search',
            agentCategory: AgentCategory.ToolUse,
            model: 'kimi26T',
            instruction: 'Check the enumeration independently.',
            inputFiles: [],
            contextFiles: [],
            mediaFiles: [],
            outputFiles: [],
            editedFile: null,
            editedFiles: [],
            toolConfig: DEFAULT_TOOL_CONFIG,
            memories: [],
            workingDirectory: undefined,
          },
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'conversation.progress',
          progress: { toolCallCount: 3 },
        },
      });

      expect(streams.get().get(root)).toMatchObject({
        model: 'kimi26T',
        category: AgentCategory.ToolUse,
        conversation: { toolCallCount: 3 },
      });
    } finally {
      detach();
    }
  });

  it('applies direct usage sequences exactly once', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const storageKey = 'root-direct-sequence-run' as StorageKey;
    const payload = {
      streamId: root,
      storageKey,
      executionId: 'exec-direct-sequence',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cost: 1,
        cacheReadInputTokens: 30,
        elapsedTime: 1.5,
        percentageCached: 25,
        reasoningTokens: 7,
      },
    };
    const secondPayload = {
      streamId: root,
      storageKey,
      executionId: 'exec-direct-sequence',
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cost: 0.5,
        cacheReadInputTokens: 5,
        elapsedTime: 0.8,
        percentageCached: 10,
        reasoningTokens: 3,
      },
    };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'usage',
          stats: payload.usage,
          data: payload,
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'usage',
          stats: secondPayload.usage,
          data: secondPayload,
        },
      });

      expect(streams.get().get(root)?.usage).toEqual(secondPayload.usage);
      expect(streams.get().get(root)?.cumulativeUsage).toEqual({
        inputTokens: 150,
        outputTokens: 30,
        cost: 1.5,
        cacheReadInputTokens: 35,
        cacheMissInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 10,
      });
    } finally {
      detach();
    }
  });

  it('registers suppressed child streams without switching away from the parent page', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    activeStreamId.set(root);

    try {
      hub.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: child1,
            suppressViewSwitch: true,
          },
        },
      });

      expect(activeStreamId.get()).toBe(root);
      expect(streams.get().has(child1)).toBe(true);
    } finally {
      detach();
    }
  });

  it('captures per-stream model identity from task state', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: child1,
        event: {
          type: 'run.config',
          streamId: child1,
          executionId: 'exec-search' as ExecutionId,
          config: {
            agent: 'search',
            agentCategory: AgentCategory.ToolUse,
            model: 'kimi26T',
            instruction: 'Check the enumeration independently.',
            inputFiles: [],
            contextFiles: [],
            mediaFiles: [],
            outputFiles: [],
            editedFile: null,
            editedFiles: [],
            toolConfig: DEFAULT_TOOL_CONFIG,
            memories: [],
            workingDirectory: undefined,
          },
        },
      });

      expect(streams.get().get(child1)).toMatchObject({
        model: 'kimi26T',
        category: AgentCategory.ToolUse,
      });
    } finally {
      detach();
    }
  });

  it('refreshes queued follow-up display when an active follow-up is sent', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    const queue = defaultSession().followUps.acquire(root);

    try {
      queue.enqueue({ text: 'Keep the proof under one page.' });
      hub.emit({
        scope: 'session',
        event: {
          type: 'followUpSent',
          payload: { streamId: root },
        },
      });

      let slice = streams.get().get(root);
      expect(slice?.queuedFollowUps).toBe(1);
      expect(slice?.queuedFollowUpMessages).toEqual([
        'Keep the proof under one page.',
      ]);

      queue.drain();
      hub.emit({
        scope: 'session',
        event: {
          type: 'updateQueuedFollowUps',
          payload: { streamId: root },
        },
      });

      slice = streams.get().get(root);
      expect(slice?.queuedFollowUps).toBe(0);
      expect(slice?.queuedFollowUpMessages).toEqual([]);
    } finally {
      detach();
      defaultSession().followUps.release(root);
    }
  });

  it('keeps latest usage separate from cumulative resume usage', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const storageKey = 'root-run' as StorageKey;

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'usage',
          stats: {},
          data: {
            streamId: root,
            storageKey,
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cost: 1,
              cacheReadInputTokens: 30,
            },
          },
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'usage',
          stats: {},
          data: {
            streamId: root,
            storageKey,
            usage: {
              inputTokens: 40,
              outputTokens: 10,
              cost: 2,
              cacheReadInputTokens: 5,
              cacheCreationInputTokens: 7,
            },
          },
        },
      });

      expect(streams.get().get(root)?.usage).toEqual({
        inputTokens: 40,
        outputTokens: 10,
        cost: 2,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 7,
      });
      expect(streams.get().get(root)?.cumulativeUsage).toEqual({
        inputTokens: 140,
        outputTokens: 30,
        cost: 3,
        cacheReadInputTokens: 35,
        cacheMissInputTokens: 0,
        cacheCreationInputTokens: 7,
      });
    } finally {
      detach();
    }
  });

  it('persists a bounded completed-process transcript before pruning processOutput', () => {
    const hub = new SessionEventHub();
    const detach = attachTuiRunFactSubscription(hub);
    const lines = Array.from(
      { length: COMPLETED_PROCESS_TAIL_LINES + 2 },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    try {
      // Seed: two live processes with tail output.
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId: root,
          processes: [
            {
              kind: 'process',
              executionId: 'exec-a',
              agentName: 'latexmk',
              toolName: 'bash',
              status: 'exit 1',
              elapsed: '2s',
            },
            { kind: 'process', executionId: 'exec-b', agentName: 'bash' },
          ],
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'process.output',
          parentStreamId: root,
          executionId: 'exec-a',
          stdout: lines,
          stderr: 'stderr tail',
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'process.output',
          parentStreamId: root,
          executionId: 'exec-b',
          stdout: 'B',
          stderr: '',
        },
      });
      expect(streams.get().get(root)?.processOutput.size).toBe(2);

      // exec-a finishes: its output buffer must be dropped on the next
      // active-processes update, after a durable transcript entry is added.
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          kind: 'processes',
          parentStreamId: root,
          processes: [
            { kind: 'process', executionId: 'exec-b', agentName: 'bash' },
          ],
        },
      });
      const slice = streams.get().get(root);
      const out = streams.get().get(root)?.processOutput;
      expect(out?.size).toBe(1);
      expect(out?.has('exec-a')).toBe(false);
      expect(out?.has('exec-b')).toBe(true);

      const processEntries =
        slice?.entries.filter((entry) => entry.role === 'process') ?? [];
      expect(processEntries).toHaveLength(1);
      expect(processEntries[0]).toMatchObject({
        role: 'process',
        finalized: true,
        synthetic: true,
        syntheticKind: 'process',
        process: {
          executionId: 'exec-a',
          title: 'latexmk',
          status: 'exit 1',
          elapsed: '2s',
          isError: true,
        },
      });
      expect(processEntries[0]?.process?.tailLines).toHaveLength(
        COMPLETED_PROCESS_TAIL_LINES,
      );
      expect(processEntries[0]?.process?.tailLines.at(0)).toBe('line 4');
      expect(processEntries[0]?.process?.tailLines.at(-1)).toBe('stderr tail');

      const split = splitTranscriptEntries(
        slice?.entries ?? [],
        STREAM_PHASE.WAITING,
      );
      expect(split.finalized).toContain(processEntries[0]);
      expect(split.pending).not.toContain(processEntries[0]);
    } finally {
      detach();
    }
  });

  it('formats completed-process transcript rows for terminal rendering', () => {
    const process = buildCompletedProcessTranscript(
      {
        kind: 'process',
        executionId: 'exec-a',
        agentName: 'latexmk',
        status: 'exit 2',
        elapsed: '5s',
      },
      {
        stdout: 'Compiling\n',
        stderr: 'fatal error\n',
      },
    );

    expect(completedProcessDisplayLines(process)).toMatchInlineSnapshot(`
      [
        "latexmk · exit 2 · 5s · error",
        "⎿ Compiling",
        "  fatal error",
      ]
    `);
  });

  it('classifies completed process error statuses', () => {
    expect(isChildExecutionErrorStatus('running')).toBe(false);
    expect(isChildExecutionErrorStatus('exit 0')).toBe(false);
    expect(isChildExecutionErrorStatus('exit 1')).toBe(true);
    expect(isChildExecutionErrorStatus('exited with code 2')).toBe(true);
    expect(isChildExecutionErrorStatus('failed')).toBe(true);
    // A user stop is not an error (RUN_OUTCOME keeps cancelled ≠ failed).
    expect(isChildExecutionErrorStatus('stopped')).toBe(false);
  });

  it('does not keep a stale running status after a process leaves the active list', () => {
    const process = buildCompletedProcessTranscript(
      {
        kind: 'process',
        executionId: 'exec-a',
        agentName: 'bash',
        status: 'running',
      },
      undefined,
    );

    expect(process.status).toBe('completed');
    expect(process.isError).toBe(false);
  });
});

describe('session tree order', () => {
  it('orders retained sibling sessions', () => {
    // Only subagents own a session, so both live siblings are modeled as
    // subagents here; a background process is never a selection target.
    applySubagentRoster(root, [
      {
        kind: 'subagent',
        executionId: 'e1',
        agentName: 'a',
        childStreamId: child1,
      },
      {
        kind: 'subagent',
        executionId: 'e2',
        agentName: 'b',
        childStreamId: child2,
      },
    ]);
    setParentStream(child1, root);
    setParentStream(child2, root);
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    patchStream(child2, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    expect(orderedSessionDescendants(root)).toEqual([child1, child2]);
  });

  it('retains an inactive child session with history', () => {
    setParentStream(child1, root);
    patchStream(root, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.WAITING }));

    expect(orderedSessionDescendants(root)).toEqual([child1]);
  });
});

// Ordered event-transition matrix for the child-stream relationship map
// (docs/proposals/cli-child-stream-state-consolidation.md, "Race-regression
// plan" / "Ordered unit matrix"). Each scenario drives the real transition
// functions the production event handlers call
// (subscribeRuntimeHost.applyActiveSubagents -> applySubagentRoster,
// subscribeRuntimeHost.applyParentStream -> setParentStream, cliState's
// removeStream -> applyChildStreamRemoval) in the stated order and asserts
// the load-bearing checkpoint(s) each sequence exists to prove, per the
// design's precedence rule:
//   removeStream tombstone > explicit edge > roster-derived parent > none.
describe('child-stream ordered transition matrix', () => {
  const parentP = 'parent-p' as StreamTabId;
  const parentQ = 'parent-q' as StreamTabId;
  const kid = 'kid' as StreamTabId;

  function rosterRow(status?: string) {
    return {
      kind: 'subagent' as const,
      executionId: 'kid-exec',
      agentName: 'kid-agent',
      childStreamId: kid,
      status,
    };
  }

  function activeRows(parent: StreamTabId) {
    return activeSubagentsFor(parent, childStreamEntries.get(), streams.get());
  }

  function retainedRows(parent: StreamTabId) {
    return retainedChildStreamsFor(
      parent,
      childStreamEntries.get(),
      streams.get(),
    );
  }

  it('1. canonical order: A, S(running), R_P+, E_P+', () => {
    patchStream(kid, (s) => ({ ...s, status: undefined }));
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);

    expect(parentStream.get().get(kid)).toBe(parentP);
    expect(activeRows(parentP)).toMatchObject([
      { status: STREAM_PHASE.RUNNING },
    ]);
    expect(retainedRows(parentP)).toMatchObject([
      { status: STREAM_PHASE.RUNNING },
    ]);
  });

  it('2. roster first: R_P+, A, S(running), E_P+', () => {
    applySubagentRoster(parentP, [rosterRow()]);
    patchStream(kid, (s) => ({ ...s, status: undefined }));
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    setParentStream(kid, parentP);

    expect(parentStream.get().get(kid)).toBe(parentP);
    expect(activeRows(parentP)).toHaveLength(1);
    expect(retainedRows(parentP)).toHaveLength(1);
  });

  it('3. edge first: E_P+, A, S(running), R_P+', () => {
    setParentStream(kid, parentP);
    // The roster hasn't arrived yet, but the edge alone already makes the
    // child reachable from the focus cycle once its slice exists (invariant
    // 6: an edge-only child is focusable once its StreamSlice exists).
    patchStream(kid, (s) => ({ ...s, status: undefined }));
    expect(parentStream.get().get(kid)).toBe(parentP);

    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow()]);

    expect(activeRows(parentP)).toHaveLength(1);
    expect(retainedRows(parentP)).toHaveLength(1);
  });

  it('4. status first: S(running), A, E_P+, R_P+', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    setParentStream(kid, parentP);
    applySubagentRoster(parentP, [rosterRow()]);

    expect(parentStream.get().get(kid)).toBe(parentP);
    expect(activeRows(parentP)).toMatchObject([
      { status: STREAM_PHASE.RUNNING },
    ]);
  });

  it('5. completion: A, S(running), R_P+, E_P+, R_P-, S(terminal)', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);

    // Untrack (roster omission) arrives before the terminal status.
    applySubagentRoster(parentP, []);
    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toHaveLength(1);

    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.COMPLETED }));

    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toMatchObject([
      { status: STREAM_PHASE.COMPLETED },
    ]);
  });

  it('6. promotion with stale roster: A, S(running), R_P+, E_P+, E0, R_P+', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    setParentStream(kid, parentP);

    setParentStream(kid, null);
    expect(parentStream.get().has(kid)).toBe(false);

    // A stale roster from the former parent must not resurrect the edge or
    // active membership.
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    expect(parentStream.get().has(kid)).toBe(false);
    expect(activeRows(parentP)).toEqual([]);
    // The historical row remains reachable from the former parent.
    expect(retainedRows(parentP)).toMatchObject([{ executionId: 'kid-exec' }]);
  });

  it('7. explicit reattachment: (6) then E_Q+, R_Q+, R_P+', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    setParentStream(kid, parentP);
    setParentStream(kid, null);
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    setParentStream(kid, parentQ);
    applySubagentRoster(parentQ, [rosterRow(STREAM_PHASE.RUNNING)]);
    // Late roster from the old parent must not erase active membership or
    // metadata under the new parent.
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    expect(parentStream.get().get(kid)).toBe(parentQ);
    expect(activeRows(parentQ)).toMatchObject([{ executionId: 'kid-exec' }]);
    expect(activeRows(parentP)).toEqual([]);
    // The historical row from the first parent survives (invariant 5/6).
    expect(retainedRows(parentP)).toMatchObject([{ executionId: 'kid-exec' }]);
  });

  it('8. child removal with late facts: (5) then X(child), R_P+, E_P+, A, S(terminal)', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    applySubagentRoster(parentP, []);
    setStreamStatusInCliState({
      status: STREAM_PHASE.COMPLETED,
      streamId: kid,
    });

    removeStream(kid);
    expect(isChildStreamRemoved(kid)).toBe(true);

    // Every later fact for the removed id must remain suppressed — status
    // facts go through `setStreamStatusInCliState` (the actual production
    // fact-application path), which checks the tombstone directly; a raw
    // `patchStream` call (used elsewhere in this file as a low-level test
    // shortcut) intentionally has no such guard.
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    setStreamStatusInCliState({ status: STREAM_PHASE.RUNNING, streamId: kid });

    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toEqual([]);
    expect(parentStream.get().has(kid)).toBe(false);
    expect(streams.get().has(kid)).toBe(false);
  });

  it('9. fresh activation after removal uses a distinct id, not the removed one', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    removeStream(kid);

    const freshKid = 'kid-2' as StreamTabId;
    patchStream(freshKid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    setParentStream(freshKid, parentP);
    applySubagentRoster(parentP, [
      {
        kind: 'subagent',
        executionId: 'kid-2-exec',
        agentName: 'kid-agent',
        childStreamId: freshKid,
        status: STREAM_PHASE.RUNNING,
      },
    ]);

    expect(isChildStreamRemoved(kid)).toBe(true);
    expect(activeRows(parentP)).toMatchObject([{ childStreamId: freshKid }]);
    expect(parentStream.get().get(freshKid)).toBe(parentP);
  });

  it('10. two-child retention keeps stable order across reordering and shrinking rosters', () => {
    const kidA = 'kid-a' as StreamTabId;
    const kidB = 'kid-b' as StreamTabId;
    const rowA = (status?: string) => ({
      kind: 'subagent' as const,
      executionId: 'exec-a',
      agentName: 'a',
      childStreamId: kidA,
      status,
    });
    const rowB = (status?: string) => ({
      kind: 'subagent' as const,
      executionId: 'exec-b',
      agentName: 'b',
      childStreamId: kidB,
      status,
    });
    patchStream(kidA, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    patchStream(kidB, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));

    // First-seen order: A then B.
    applySubagentRoster(parentP, [rowA(), rowB()]);
    expect(retainedRows(parentP).map((r) => r.childStreamId)).toEqual([
      kidA,
      kidB,
    ]);

    // A later roster reorders (B, A) — retained order must not change.
    applySubagentRoster(parentP, [rowB(), rowA()]);
    expect(retainedRows(parentP).map((r) => r.childStreamId)).toEqual([
      kidA,
      kidB,
    ]);

    // Shrink to just B; A completes.
    applySubagentRoster(parentP, [rowB()]);
    patchStream(kidA, (s) => ({ ...s, status: STREAM_PHASE.COMPLETED }));

    expect(activeRows(parentP).map((r) => r.childStreamId)).toEqual([kidB]);
    // Retained order is still stable and A's historical row survives.
    expect(retainedRows(parentP).map((r) => r.childStreamId)).toEqual([
      kidA,
      kidB,
    ]);
    expect(
      visibleSubagentRows(parentP, childStreamEntries.get(), streams.get()).map(
        (r) => r.status,
      ),
    ).toEqual([STREAM_PHASE.COMPLETED, STREAM_PHASE.RUNNING]);
  });

  it('11. parent removal with late facts: P -> child, X(P), R_P+, E_P+', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    patchStream(parentP, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));

    removeStream(parentP);
    expect(isChildStreamRemoved(parentP)).toBe(true);

    // Late facts naming the removed parent must not resurrect it as an
    // ancestor anywhere.
    applySubagentRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);

    expect(parentStream.get().get(kid)).toBeUndefined();
    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toEqual([]);
  });

  it('12. identical roster snapshot applied twice is a no-op (no store write)', () => {
    patchStream(kid, (s) => ({ ...s, status: STREAM_PHASE.RUNNING }));
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    const entriesAfterFirst = childStreamEntries.get();

    // The runtime resends a fresh array/row object on every poll even when
    // nothing changed; `rosterRow` below is a distinct object with identical
    // field values, not `===` to the first call's row.
    applySubagentRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    expect(childStreamEntries.get()).toBe(entriesAfterFirst);
  });
});
