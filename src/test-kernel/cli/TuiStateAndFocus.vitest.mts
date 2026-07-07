// Phase 4 state + focus-cycle smoke.

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunTrace,
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
  type StreamSnapshotStore,
} from '@transcript';
import { clearAllStreamStatusesForTest } from '@test/helpers/streamStatusTestUtils';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { toRunFactDomainKey } from '@agent/runtime/runFactEvents';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import {
  activeStreamId,
  rootRunStartAvailable,
  rootStreamId,
} from '@cli/chat/tui/state/cliState/focusSlice';
import {
  parentStream,
  setParentStream,
} from '@cli/chat/tui/state/cliState/parentStreamSlice';
import { removeStream } from '@cli/chat/tui/state/cliState/removeStream';
import { resetCliState } from '@cli/chat/tui/state/cliState/reset';
import {
  patchStream,
  streams,
} from '@cli/chat/tui/state/cliState/streamsSlice';
import {
  allocateMiddleRows,
  allocateSidePanelRows,
  appEscapeInterruptActive,
  appFocusShortcutsActive,
  approvalForegroundMaxRows,
  approvalVisibleForActiveStream,
  childControlForegroundMaxRows,
  digitFromMetaShortcut,
  foregroundEscapeAction,
  foregroundSurfaceKind,
  shouldDeferEscapeInterruptForMetaChord,
  shouldShowTipRow,
  shouldShowTodosPlanPanel,
  staticTranscriptRowBudget,
  triggerEscapeInterrupt,
} from '@cli/chat/tui/App';
import type { PendingApproval } from '@cli/chat/tui/state/approvalQueue';
import {
  nextFocusBack,
  nextFocusForward,
} from '@cli/chat/tui/state/focusCycle';
import { hasChildControlItems } from '@cli/chat/tui/state/childControls';
import { focusedChildInputDisabledMessage } from '@cli/chat/tui/state/focusedChildFollowUp';
import { visibleSubagentRows } from '@cli/chat/tui/state/childExecutions';
import {
  finalizeSettledPrefix,
  syncStreamLog,
} from '@cli/chat/tui/state/subscribeStreamLog';
import { transcriptViewportKey } from '@cli/chat/tui/state/transcriptViewportMode';
import { projectStreamTranscript } from '@cli/chat/tui/state/transcriptProjection';
import { subscribeStreamStatus } from '@cli/chat/tui/state/subscribeStreamStatus';
import {
  attachTuiRunFactSubscription,
  wrapRuntimeHost,
} from '@cli/chat/tui/state/subscribeRuntimeHost';
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
import { installTuiStdoutListenerLimit } from '@cli/chat/tui/render/noColorOutput';
import { CliExitCode } from '@cli/runtime/exitCodes';
import {
  appendAssistantTranscriptIfMissing,
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
  clearLocalTranscript,
  CLI_LOCAL_STREAM_ID,
  moveLocalTranscriptToStream,
  resolveLocalTranscriptStreamId,
} from '@cli/chat/tui/state/transcript';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  MESSAGE_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  TODO_STATUS,
  type ActiveChildInfo,
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

afterEach(() => {
  clearAllStreamStatusesForTest(StreamStatusService);
  resetCliState();
});

describe('cliState Phase 4 fields', () => {
  it('initialises every new slice with empty subagent/process/todo/plan/bypass defaults', () => {
    patchStream(root, (s) => ({ ...s, status: 'running' }));
    const slice = streams.get().get(root);
    expect(slice).toBeDefined();
    expect(slice?.activeSubagents).toEqual([]);
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
    setParentStream(child1, root);
    patchStream(root, (s) => ({
      ...s,
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'history-1',
          agentName: 'critic',
          childStreamId: child1,
          status: 'completed',
        },
      ],
      activeSubagents: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: child1,
          status: STREAM_STATUS.RUNNING,
        },
      ],
      // Processes never own a stream tab, so an unrelated background process
      // must be untouched by removing child1's stream below.
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'process-1',
          agentName: 'bash',
          status: STREAM_STATUS.RUNNING,
        },
      ],
    }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));

    expect(hasChildControlItems(streams.get().get(root), 'tasks')).toBe(true);
    expect(hasChildControlItems(streams.get().get(root), 'subagents')).toBe(
      true,
    );
    expect(nextFocusForward()).toBe(child1);

    removeStream(child1);

    const parent = streams.get().get(root);
    expect(parent).toBeDefined();
    if (!parent) throw new Error('missing parent stream');
    expect(parent.childStreams).toEqual([]);
    expect(parent.activeSubagents).toEqual([]);
    // Unaffected: process-1 never referenced child1's stream.
    expect(parent.activeProcesses).toMatchObject([
      { executionId: 'process-1' },
    ]);
    expect(visibleSubagentRows(parent)).toEqual([]);
    // Still true: the untouched process-1 counts as a task-mode item.
    expect(hasChildControlItems(parent, 'tasks')).toBe(true);
    expect(hasChildControlItems(parent, 'subagents')).toBe(false);
    expect(nextFocusForward()).toBeUndefined();
  });

  it('updates retained child rows when a failed subagent leaves the active list', () => {
    const wrapped = wrapRuntimeHost({
      emit: () => undefined,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const dispose = subscribeStreamStatus();
    try {
      patchStream(root, (s) => ({
        ...s,
        activeSubagents: [
          {
            kind: 'subagent',
            executionId: 'agent-1',
            agentName: 'codex',
            childStreamId: child1,
            status: STREAM_STATUS.RUNNING,
          },
        ],
        childStreams: [
          {
            kind: 'subagent',
            executionId: 'agent-1',
            agentName: 'codex',
            childStreamId: child1,
            status: STREAM_STATUS.RUNNING,
          },
        ],
      }));
      patchStream(root, (s) => ({ ...s, activeSubagents: [] }));

      StreamStatusService.transition(
        child1,
        STREAM_PHASE.FAILED,
        'restart-repair',
        {
          runtimeHost: wrapped,
        },
      );

      const parent = streams.get().get(root);
      expect(parent?.activeSubagents).toEqual([]);
      expect(parent?.childStreams[0]?.status).toBe(STREAM_PHASE.FAILED);
      expect(visibleSubagentRows(parent!)).toMatchObject([
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
    const wrapped = wrapRuntimeHost({
      emit: () => undefined,
      close: async () => {},
    } as unknown as CliRuntimeHost);

    activeStreamId.set(root);
    patchStream(child1, (s) => ({
      ...s,
      status: STREAM_STATUS.RUNNING,
    }));

    wrapped.emit('updateActiveSubagents', {
      parentStreamId: root,
      children: [
        {
          kind: 'subagent',
          executionId: 'agent-1',
          agentName: 'critic',
          childStreamId: child1,
          status: STREAM_STATUS.RUNNING,
        },
      ],
    });

    expect(parentStream.get().get(child1)).toBe(root);
    expect(nextFocusForward()).toBe(child1);
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
  });
});

describe('chat TUI stdout listener limit', () => {
  it('raises and restores the listener ceiling for the mounted TUI lifetime', () => {
    const stream = new EventEmitter();
    stream.setMaxListeners(10);

    const restore = installTuiStdoutListenerLimit(stream);

    expect(stream.getMaxListeners()).toBeGreaterThan(10);

    restore();
    expect(stream.getMaxListeners()).toBe(10);

    restore();
    expect(stream.getMaxListeners()).toBe(10);
  });

  it('does not lower a listener ceiling changed after installation', () => {
    const stream = new EventEmitter();
    stream.setMaxListeners(10);
    const restore = installTuiStdoutListenerLimit(stream);

    stream.setMaxListeners(128);
    restore();

    expect(stream.getMaxListeners()).toBe(128);
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
    expect(layout.foregroundRows).toBe(17);
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
    expect(layout.foregroundRows).toBe(6);
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
    expect(layout.foregroundRows).toBe(18);
  });

  it('uses a smaller row cap for empty child-control pickers', () => {
    expect(childControlForegroundMaxRows({ hasItems: false })).toBe(6);
    expect(childControlForegroundMaxRows({ hasItems: true })).toBe(12);
  });

  it('does not cap natural-height approval prompts that lack row budgeting', () => {
    const decide = () => {};

    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'plan',
          payload: {
            approvalId: 'plan-1',
            streamId: root,
            goalEnabled: false,
            plan: { objective: 'Coordinate a proof.' },
          },
        },
        decide,
      }),
    ).toBeUndefined();
    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'retry',
          payload: { streamId: root, operation: 'Model invocation' },
        },
        decide,
      }),
    ).toBeUndefined();
    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'userQuestion',
          payload: {
            requestId: 'question-1',
            allowBypass: false,
            streamId: root,
            context: 'Pick a proof style.',
            questions: [
              {
                question: 'Which style?',
                options: [{ label: 'direct' }, { label: 'detailed' }],
              },
            ],
          },
        },
        decide,
      }),
    ).toBeUndefined();
    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'bash',
          payload: {
            requestId: 'bash-1',
            allowBypass: true,
            streamId: root,
            command: 'echo ok',
          },
        },
        decide,
      }),
    ).toBe(18);
    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'toolEdit',
          payload: {
            path: 'draft.tex',
            originalContent: 'old',
            proposedContent: 'new',
            sourceTool: 'test',
            streamId: root,
          },
        },
        decide,
      }),
    ).toBe(18);
    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'proposal',
          payload: {
            proposalId: 'proposal-1',
            streamId: root,
            agentCategory: AgentCategory.ToolUse,
            agent: 'review',
            model: 'harness-model',
            instruction: 'Review the proof.',
            memories: [],
            workingDirectory: '/tmp',
          },
        },
        decide,
      }),
    ).toBe(18);
    expect(
      approvalForegroundMaxRows({
        payload: {
          kind: 'externalInquiry',
          payload: {
            requestId: 'inquiry-1',
            mode: 'new' as const,
            threadId: 'ei_000000000001',
            allowBypass: false,
            streamId: root,
            question: 'Can you check this claim?',
            sessionLinks: null,
            draft: null,
            transcript: null,
          },
        },
        decide,
      }),
    ).toBe(18);
  });

  it('uses the whole middle region for the transcript without foreground UI', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(17);
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

    expect(layout.transcriptRows).toBe(15);
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

  it('keeps the compact live reserve aligned with stream tab visibility', () => {
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
        streamTabsVisible: false,
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

    expect(layout.transcriptRows).toBe(12);
    expect(layout.foregroundRows).toBe(0);
  });

  it('returns former header rows to the transcript when slash palette is open', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: true,
    });

    expect(layout.transcriptRows).toBe(4);
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
        status: STREAM_STATUS.RUNNING,
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
        status: STREAM_STATUS.WAITING,
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
        status: STREAM_STATUS.RUNNING,
        todos: [openTodo],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        status: STREAM_STATUS.RUNNING,
        todos: [],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: true,
        status: STREAM_STATUS.RUNNING,
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

  it('lets input overlays own focus shortcuts', () => {
    expect(
      appFocusShortcutsActive({
        foregroundOpen: false,
        reverseSearchOpen: false,
        slashPaletteOpen: false,
      }),
    ).toBe(true);
    expect(
      appFocusShortcutsActive({
        foregroundOpen: false,
        reverseSearchOpen: true,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appFocusShortcutsActive({
        foregroundOpen: false,
        reverseSearchOpen: false,
        slashPaletteOpen: true,
      }),
    ).toBe(false);
    expect(
      appFocusShortcutsActive({
        foregroundOpen: true,
        reverseSearchOpen: false,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
  });

  it('only lets Escape interrupt when no foreground input owns it', () => {
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        runPending: true,
        slashPaletteOpen: false,
      }),
    ).toBe(true);
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        runPending: false,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appEscapeInterruptActive({
        inputDisabled: true,
        reverseSearchOpen: false,
        runPending: true,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: true,
        runPending: true,
        slashPaletteOpen: false,
      }),
    ).toBe(false);
    expect(
      appEscapeInterruptActive({
        inputDisabled: false,
        reverseSearchOpen: false,
        runPending: true,
        slashPaletteOpen: true,
      }),
    ).toBe(false);
  });

  it('defers Escape interrupt only when stopped child Esc chords are visible', () => {
    expect(
      shouldDeferEscapeInterruptForMetaChord({
        childInputDisabled: true,
        shortcutModifierLabel: 'Esc',
        subagentControlsAvailable: true,
        taskControlsAvailable: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferEscapeInterruptForMetaChord({
        childInputDisabled: true,
        shortcutModifierLabel: 'Esc',
        subagentControlsAvailable: false,
        taskControlsAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldDeferEscapeInterruptForMetaChord({
        childInputDisabled: false,
        shortcutModifierLabel: 'Esc',
        subagentControlsAvailable: true,
        taskControlsAvailable: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferEscapeInterruptForMetaChord({
        childInputDisabled: true,
        shortcutModifierLabel: 'Alt',
        subagentControlsAvailable: true,
        taskControlsAvailable: false,
      }),
    ).toBe(false);
    expect(
      shouldDeferEscapeInterruptForMetaChord({
        childInputDisabled: true,
        shortcutModifierLabel: 'Esc',
        subagentControlsAvailable: false,
        taskControlsAvailable: false,
      }),
    ).toBe(false);
  });

  it('parses stripped meta shortcut digits', () => {
    expect(digitFromMetaShortcut('1')).toBe(1);
    expect(digitFromMetaShortcut('9')).toBe(9);
    expect(digitFromMetaShortcut('0')).toBeUndefined();
    expect(digitFromMetaShortcut('10')).toBeUndefined();
    expect(digitFromMetaShortcut('p')).toBeUndefined();
  });

  it('runs Escape interrupt from the supplied current state', () => {
    let interrupts = 0;
    expect(
      triggerEscapeInterrupt({
        inputDisabled: false,
        reverseSearchOpen: false,
        slashPaletteOpen: false,
        canInterruptActiveRun: () => true,
        onInterruptActive: () => {
          interrupts += 1;
        },
      }),
    ).toBe(true);
    expect(interrupts).toBe(1);

    expect(
      triggerEscapeInterrupt({
        inputDisabled: false,
        reverseSearchOpen: false,
        slashPaletteOpen: false,
        canInterruptActiveRun: () => false,
        onInterruptActive: () => {
          interrupts += 1;
        },
      }),
    ).toBe(false);
    expect(interrupts).toBe(1);
  });

  it('keeps user-opened foreground surfaces ahead of new approvals', () => {
    expect(
      foregroundSurfaceKind({
        activeFormOpen: false,
        childControlMode: 'subagents',
        pendingApproval: true,
        transcriptViewerOpen: false,
      }),
    ).toBe('childControls');

    expect(
      foregroundSurfaceKind({
        activeFormOpen: false,
        childControlMode: undefined,
        pendingApproval: true,
        transcriptViewerOpen: true,
      }),
    ).toBe('transcript');

    expect(
      foregroundSurfaceKind({
        activeFormOpen: true,
        childControlMode: undefined,
        pendingApproval: true,
        transcriptViewerOpen: false,
      }),
    ).toBe('form');
  });

  it('shows approvals when no existing foreground surface owns input', () => {
    expect(
      foregroundSurfaceKind({
        activeFormOpen: false,
        childControlMode: undefined,
        pendingApproval: true,
        transcriptViewerOpen: false,
      }),
    ).toBe('approval');

    expect(
      foregroundSurfaceKind({
        activeFormOpen: false,
        childControlMode: undefined,
        pendingApproval: false,
        transcriptViewerOpen: false,
      }),
    ).toBeUndefined();
  });

  it('shows stream-owned approvals only on their matching tab', () => {
    const childApproval = {
      payload: {
        kind: 'bash',
        payload: {
          requestId: 'bash-1',
          command: 'echo ok',
          allowBypass: true,
          streamId: 'child-1',
        },
      },
      decide: () => undefined,
    } satisfies PendingApproval;
    const globalApproval = {
      payload: {
        kind: 'toolEdit',
        payload: {
          path: 'paper.tex',
          originalContent: '',
          proposedContent: '',
          sourceTool: 'edit',
        },
      },
      decide: () => undefined,
    } satisfies PendingApproval;

    expect(
      approvalVisibleForActiveStream({
        activeStreamId: 'child-1',
        pending: childApproval,
      }),
    ).toBe(true);
    expect(
      approvalVisibleForActiveStream({
        activeStreamId: 'root',
        pending: childApproval,
      }),
    ).toBe(false);
    expect(
      approvalVisibleForActiveStream({
        activeStreamId: 'root',
        pending: globalApproval,
      }),
    ).toBe(true);
  });

  it('keeps hidden stream-owned approvals from taking the foreground', () => {
    const childApproval = {
      payload: {
        kind: 'bash',
        payload: {
          requestId: 'bash-1',
          command: 'echo ok',
          allowBypass: true,
          streamId: 'child-1',
        },
      },
      decide: () => undefined,
    } satisfies PendingApproval;

    expect(
      approvalVisibleForActiveStream({
        activeStreamId: 'root',
        pending: childApproval,
      }),
    ).toBe(false);
  });

  it('keeps stream focus shortcuts available for hidden approvals', () => {
    const childApproval = {
      payload: {
        kind: 'bash',
        payload: {
          requestId: 'bash-1',
          command: 'echo ok',
          allowBypass: true,
          streamId: 'child-1',
        },
      },
      decide: () => undefined,
    } satisfies PendingApproval;

    expect(
      approvalVisibleForActiveStream({
        activeStreamId: 'root',
        pending: childApproval,
      }),
    ).toBe(false);
    expect(
      appFocusShortcutsActive({
        foregroundOpen: false,
        reverseSearchOpen: false,
        slashPaletteOpen: false,
      }),
    ).toBe(true);
  });

  it('labels foreground escape actions from the owning surface', () => {
    const pending = (
      kind: PendingApproval['payload']['kind'],
    ): PendingApproval =>
      ({
        payload: { kind } as PendingApproval['payload'],
        decide: () => undefined,
      }) satisfies PendingApproval;

    expect(
      foregroundEscapeAction({
        childControlEscapeAction: 'close',
        foregroundKind: 'childControls',
        pending: undefined,
      }),
    ).toBe('close');
    expect(
      foregroundEscapeAction({
        childControlEscapeAction: 'back',
        foregroundKind: 'childControls',
        pending: undefined,
      }),
    ).toBe('back');
    expect(
      foregroundEscapeAction({ foregroundKind: 'form', pending: undefined }),
    ).toBe('close');
    expect(
      foregroundEscapeAction({
        activeFormEscapeAction: 'cancel',
        foregroundKind: 'form',
        pending: undefined,
      }),
    ).toBe('cancel');
    expect(
      foregroundEscapeAction({
        foregroundKind: 'approval',
        pending: pending('externalInquiry'),
      }),
    ).toBe('skip');
    expect(
      foregroundEscapeAction({
        foregroundKind: 'approval',
        pending: pending('bash'),
      }),
    ).toBe('cancel');
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
  });

  it('restores root run availability when clearing session run state', () => {
    const startupPromise = new Promise<void>(() => {});
    const session = {
      streamId: root,
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
        status: STREAM_STATUS.WAITING,
        hasActiveToolUseFlow: true,
      }),
    ).toBe(true);
    expect(
      chatTuiCanSelectModel({
        canStartRootRun: false,
        streamId: root,
        status: STREAM_STATUS.RUNNING,
        hasActiveToolUseFlow: true,
      }),
    ).toBe(false);
    expect(
      chatTuiCanSelectModel({
        canStartRootRun: false,
        streamId: root,
        status: STREAM_STATUS.WAITING,
        hasActiveToolUseFlow: false,
      }),
    ).toBe(false);
  });

  it('only reports Ctrl-C stoppable while the root stream is actively responding', () => {
    const runPromise = Promise.resolve();

    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: undefined,
        },
        undefined,
      ),
    ).toBe(true);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_STATUS.RUNNING,
      ),
    ).toBe(true);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_PHASE.RUNNING,
      ),
    ).toBe(true);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_PHASE.RUNNING,
      ),
    ).toBe(true);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_STATUS.WAITING,
      ),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_PHASE.FAILED,
      ),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_PHASE.CANCELLED,
      ),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: false,
          runPromise,
          streamId: root,
        },
        STREAM_STATUS.READY,
      ),
    ).toBe(false);
    expect(
      chatTuiCanStopActiveRun(
        {
          runCompleted: true,
          runPromise,
          streamId: root,
        },
        STREAM_STATUS.RUNNING,
      ),
    ).toBe(false);
  });

  it('keeps Ctrl-C stoppable when the visible stream is already live', () => {
    expect(
      chatTuiCanStopVisibleRun(
        {
          runCompleted: false,
          runPromise: undefined,
          streamId: root,
        },
        STREAM_STATUS.RUNNING,
      ),
    ).toBe(true);
    expect(
      chatTuiCanStopVisibleRun(
        {
          runCompleted: true,
          runPromise: undefined,
          streamId: root,
        },
        STREAM_PHASE.RUNNING,
      ),
    ).toBe(true);
    expect(
      chatTuiCanStopVisibleRun(
        {
          runCompleted: false,
          runPromise: undefined,
          streamId: undefined,
        },
        STREAM_STATUS.RUNNING,
      ),
    ).toBe(false);
    expect(
      chatTuiCanStopVisibleRun(
        {
          runCompleted: false,
          runPromise: undefined,
          streamId: root,
        },
        STREAM_STATUS.WAITING,
      ),
    ).toBe(false);
  });

  it('resolves the TUI Ctrl-C action from armed, stoppable, and interruptible state', () => {
    expect(
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun: false,
        canInterruptActiveRun: false,
      }),
    ).toBe('clean-exit');

    expect(
      // Idle/WAITING (interruptible, not stoppable): exit WITHOUT interrupting
      // so the suspended tool-use flow record and terminal status survive.
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun: false,
        canInterruptActiveRun: true,
      }),
    ).toBe('preserve-exit');

    expect(
      chatTuiSigintAction({
        exitArmed: false,
        canStopActiveRun: true,
        canInterruptActiveRun: true,
      }),
    ).toBe('interrupt-and-arm-exit');

    expect(
      chatTuiSigintAction({
        exitArmed: true,
        canStopActiveRun: true,
        canInterruptActiveRun: true,
      }),
    ).toBe('force-exit');
  });

  it('selects the focused child stream as a follow-up target', () => {
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
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
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(root, (s) => ({
      ...s,
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'child-exec-1',
          agentName: 'critic',
          childStreamId: child1,
          status: STREAM_PHASE.COMPLETED,
        },
      ],
    }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.RUNNING }));
    setParentStream(child1, root);

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'accept',
      streamId: child1,
    });
  });

  it('uses child slice status as a fallback for focused child follow-ups', () => {
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(root, (s) => ({
      ...s,
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'child-exec-1',
          agentName: 'critic',
          childStreamId: child1,
          status: STREAM_STATUS.RUNNING,
        },
      ],
    }));
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
        status: STREAM_STATUS.RUNNING,
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
      'Subagent is no longer accepting follow-ups; press Tab to switch streams or Esc s to choose another.',
    );

    expect(
      focusedChildInputDisabledMessage({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        shortcutModifierLabel: 'Alt',
        status: STREAM_PHASE.COMPLETED,
      }),
    ).toBe(
      'Subagent is no longer accepting follow-ups; press Tab to switch streams or Alt-s to choose another.',
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
      'Subagent is no longer accepting follow-ups; press Tab to switch streams.',
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
      'Subagent is no longer accepting follow-ups; press Tab to switch streams or Esc p to review tasks.',
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
      'Subagent is no longer accepting follow-ups; press Tab to switch streams or Esc s to choose another, or Esc p to review tasks.',
    );
  });

  it('mirrors running child status events into focused child routing', () => {
    const wrapped = wrapRuntimeHost({
      emit: () => undefined,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const dispose = subscribeStreamStatus();
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(root, (s) => ({
      ...s,
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'child-exec-1',
          agentName: 'critic',
          childStreamId: child1,
          status: STREAM_PHASE.COMPLETED,
        },
      ],
    }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_PHASE.CANCELLED }));
    setParentStream(child1, root);

    try {
      StreamStatusService.transition(
        child1,
        STREAM_PHASE.RUNNING,
        'restart-repair',
        {
          runtimeHost: wrapped,
        },
      );

      activeStreamId.set(child1);
      expect(streams.get().get(child1)?.status).toBe(STREAM_STATUS.RUNNING);
      expect(streams.get().get(root)?.childStreams[0]?.status).toBe(
        STREAM_STATUS.RUNNING,
      );
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });
    } finally {
      dispose();
    }
  });

  it('mirrors stopped child status events into focused child routing', () => {
    const wrapped = wrapRuntimeHost({
      emit: () => undefined,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const dispose = subscribeStreamStatus();
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(root, (s) => ({
      ...s,
      childStreams: [
        {
          kind: 'subagent',
          executionId: 'child-exec-1',
          agentName: 'critic',
          childStreamId: child1,
          status: STREAM_STATUS.RUNNING,
        },
      ],
    }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.RUNNING }));
    setParentStream(child1, root);

    try {
      StreamStatusService.transition(
        child1,
        STREAM_PHASE.CANCELLED,
        'restart-repair',
        {
          runtimeHost: wrapped,
        },
      );

      activeStreamId.set(child1);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.CANCELLED);
      expect(streams.get().get(root)?.childStreams[0]?.status).toBe(
        STREAM_PHASE.CANCELLED,
      );
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
      executionId: 'old-execution',
      runPromise: Promise.resolve(),
      runExitCode: CliExitCode.Interrupted,
      runCompleted: true,
      stopRequested: true,
    };

    clearTuiSessionRunState(session);

    expect(session).toMatchObject({
      streamId: undefined,
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
  // read and write the *default* stream log store. Give every test in this
  // block a fresh store up front and restore the original afterward, so
  // store-backed tests don't need to repeat that swap individually.
  let previousStore: StreamLogStore;

  beforeEach(() => {
    previousStore = getDefaultStreamLogStore();
    setDefaultStreamLogStore(new StreamLogStore());
  });

  afterEach(() => {
    setDefaultStreamLogStore(previousStore);
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
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
    logger.info(
      '<h3>Verification Report</h3>The proof is <b>fully verified</b>.',
      { messageType: MESSAGE_TYPES.MODEL_RESPONSE },
    );

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      '### Verification Report\n\nThe proof is **fully verified**.',
    ]);
    expect(entries[0]?.text).not.toContain('<h3>');
    expect(entries[0]?.text).not.toContain('<b>');
  });

  it('bounds long subagent result responses in the visible transcript', () => {
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
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
    const logger = createRunTrace(root).trace;
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

  it('adds a final assistant response only when the stream log did not render it', () => {
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final');
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'The answer is 2.',
      finalized: true,
    });
  });

  it('does not duplicate waiting and final fallback entries for the same response', () => {
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'waiting:1');
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final:1');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.id)).toEqual(['waiting:1:root']);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'The answer is 2.',
      finalized: true,
      synthetic: true,
    });
  });

  it('dedupes synthetic checkmark aliases from the same stream anchor', () => {
    appendAssistantTranscriptIfMissing(root, 'Done \\checkmark', 'waiting:1');
    appendAssistantTranscriptIfMissing(root, 'Done ✓', 'final:1');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual(['Done \\checkmark']);
  });

  it('keeps distinct synthetic fallback responses from the same stream anchor', () => {
    appendAssistantTranscriptIfMissing(
      root,
      'The condition is x < y.',
      'first',
    );
    appendAssistantTranscriptIfMissing(
      root,
      'The condition is x > y.',
      'second',
    );

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'The condition is x < y.',
      'The condition is x > y.',
    ]);
  });

  it('keeps repeated final responses from distinct turns visible', () => {
    const logger = createRunTrace(root).trace;
    logger.info('first prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'Done.', 'final:first');

    logger.info('second prompt', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'Done.', 'final:second');

    logger.info('third prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'first prompt',
      'Done.',
      'second prompt',
      'Done.',
      'third prompt',
    ]);
  });

  it('does not duplicate a final response already present in the stream log', () => {
    const logger = createRunTrace(root).trace;
    logger.info('Done.', { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'Done.', 'final:first');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual(['Done.']);
    expect(entries[0]?.synthetic).toBeUndefined();
  });

  it('lets the stream-log assistant own final text even when fallback text differs', () => {
    const logger = createRunTrace(root).trace;
    logger.info('| x | Check |\n|---|---|\n| 3 | 1 ✓ |', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(
      root,
      '| x | Check |\n|---|---|\n| 3 | 1 \\checkmark |',
      'final:first',
    );

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      '| x | Check |\n|---|---|\n| 3 | 1 ✓ |',
    ]);
    expect(entries[0]?.synthetic).toBeUndefined();
  });

  it('does not let a pre-tool stream assistant suppress final fallback text', () => {
    const logger = createRunTrace(root).trace;
    logger.info('| x | Check |\n|---|---|\n| 3 | 1 ✓ |', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    logger.info('', {
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: {
        toolName: 'bash',
        input: { command: 'true' },
        output: { summary: 'Executed: true', output: 'ok' },
        status: 'completed',
      },
    });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(
      root,
      'Final answer after the tool.',
      'final:first',
    );

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(entries.map((entry) => entry.text)).toEqual([
      '| x | Check |\n|---|---|\n| 3 | 1 ✓ |',
      '',
      'Final answer after the tool.',
    ]);
  });

  it('dedupes fallback text that already appeared before a tool row', () => {
    const logger = createRunTrace(root).trace;
    logger.info('Intermediate result ✓', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    logger.info('', {
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: {
        toolName: 'bash',
        input: { command: 'true' },
        output: { summary: 'Executed: true', output: 'ok' },
        status: 'completed',
      },
    });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(
      root,
      'Intermediate result \\checkmark',
      'final:matching',
    );
    appendAssistantTranscriptIfMissing(
      root,
      'Final answer after the tool.',
      'final:actual',
    );

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'Intermediate result ✓',
      '',
      'Final answer after the tool.',
    ]);
  });

  it('does not let a prior-turn stream assistant suppress fallback text', () => {
    const logger = createRunTrace(root).trace;
    logger.info('first prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    logger.info('Done ✓', { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
    syncStreamLog(root);

    logger.info('second prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'Done \\checkmark', 'final:2');

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'first prompt',
      'Done ✓',
      'second prompt',
      'Done \\checkmark',
    ]);
    expect(entries.at(-1)).toMatchObject({
      synthetic: true,
      syntheticKind: 'final',
    });
  });

  it('projects a turn boundary without duplicating fallback assistant text', () => {
    const logger = createRunTrace(root).trace;
    logger.info('What is 1 + 1?', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    logger.info('2', { messageType: MESSAGE_TYPES.MODEL_RESPONSE });

    projectStreamTranscript(root, {
      fallbackAssistant: { text: '2', idPrefix: 'final:turn' },
      finalize: true,
    });

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual(['What is 1 + 1?', '2']);
    expect(entries.map((entry) => entry.finalized)).toEqual([true, true]);
    expect(entries.some((entry) => entry.id === 'final:turn:root')).toBe(false);
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
    const logger = createRunTrace(root).trace;
    const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    stream.append('A short final answer.');

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      'A short final answer.',
    ]);
  });

  it('finalizes a delayed first model-response sync after the stream is idle', () => {
    const logger = createRunTrace(root).trace;
    logger.info('A delayed final answer.', {
      messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    });
    patchStream(root, (slice) => ({
      ...slice,
      status: STREAM_STATUS.WAITING,
    }));

    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'A delayed final answer.',
      finalized: true,
    });
    const split = splitTranscriptEntries(entries, STREAM_STATUS.WAITING);
    expect(split.finalized.map((entry) => entry.id)).toEqual([entries[0]?.id]);
    expect(split.pending).toEqual([]);
  });

  it('keeps repeated local slash-command responses after stream-log syncs', () => {
    const logger = createRunTrace(root).trace;
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
      STREAM_STATUS.RUNNING,
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

  it('preserves synthetic final responses across later log syncs', () => {
    const logger = createRunTrace(root).trace;
    logger.info('1+1', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'The answer is 2.', 'final');

    logger.info('next prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);

    const entries = streams.get().get(root)?.entries ?? [];
    expect(entries.map((entry) => entry.text)).toEqual([
      '1+1',
      'The answer is 2.',
      'next prompt',
    ]);
  });

  it('orders multiple synthetic responses relative to their stream-log anchors', () => {
    const logger = createRunTrace(root).trace;
    logger.info('first prompt', { messageType: MESSAGE_TYPES.USER_MESSAGE });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'first answer', 'final-1');

    logger.info('second prompt', {
      messageType: MESSAGE_TYPES.USER_MESSAGE,
    });
    syncStreamLog(root);
    appendAssistantTranscriptIfMissing(root, 'second answer', 'final-2');

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
  });
});

describe('subscribeRuntimeHost.updateActiveProcesses', () => {
  function makeHost(): CliRuntimeHost {
    return {
      emit: () => {},
      close: async () => {},
    } as unknown as CliRuntimeHost;
  }

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

  it('applies direct runFact.updateTodos events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
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
          type: 'domain',
          key: toRunFactDomainKey('updateTodos'),
          data: { streamId: root, todos },
        },
      });

      expect(streams.get().get(root)?.todos).toEqual(todos);
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct runFact.updatePlan events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
    const detach = attachTuiRunFactSubscription(hub);
    const plan: Plan = {
      objective: 'Prove the local estimate and record the stopping criterion.',
    };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'domain',
          key: toRunFactDomainKey('updatePlan'),
          data: { streamId: root, plan },
        },
      });

      expect(streams.get().get(root)?.plan).toEqual(plan);
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct runFact.goalPaused events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
    const detach = attachTuiRunFactSubscription(hub);

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'domain',
          key: toRunFactDomainKey('goalPaused'),
          data: { streamId: root },
        },
      });

      expect(
        streams
          .get()
          .get(root)
          ?.entries.map((entry) => entry.text),
      ).toEqual([GOAL_PAUSED_TRANSCRIPT_NOTICE]);
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct stage.start(kind: round) events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
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
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('ignores direct non-round stage.start events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
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
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct child.activity(subagents) and parent events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
    const detach = attachTuiRunFactSubscription(hub);
    const child: ActiveChildInfo = {
      kind: 'subagent',
      executionId: 'agent-1',
      agentName: 'critic',
      childStreamId: child1,
      status: STREAM_STATUS.RUNNING,
    };

    try {
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
        scope: 'run',
        streamId: child2,
        event: {
          type: 'child.activity',
          kind: 'parent',
          childStreamId: child2,
          parentStreamId: root,
        },
      });

      expect(streams.get().get(root)?.activeSubagents).toEqual([child]);
      expect(streams.get().get(root)?.childStreams).toEqual([child]);
      expect(parentStream.get().get(child1)).toBe(root);
      expect(parentStream.get().get(child2)).toBe(root);
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct process.output events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
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
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct child.activity(processes) completion and prunes output once', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
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
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('applies direct usage events without host emission', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const wrappedEmit = vi.spyOn(wrapped, 'emit');
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
      expect(wrappedEmit).not.toHaveBeenCalled();
      expect(hostEmit).not.toHaveBeenCalled();
    } finally {
      detach();
      wrappedEmit.mockRestore();
    }
  });

  it('does not double-count projected usage when the TUI subscriber is first', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    // Regression coverage for #7388: `attachTuiRunFactSubscription` is
    // registered on the hub before the CLI projection here (the order
    // `chatSessionController.ts` uses today), and two distinct usage events
    // are emitted so the guard's dedupe is proven across a sequence, not just
    // a single isolated pairing.
    const detachTui = attachTuiRunFactSubscription(hub);
    const detachProjection = attachCliSessionProgressProjection(hub, wrapped);
    const storageKey = 'root-echo-run' as StorageKey;
    const payload = {
      streamId: root,
      storageKey,
      executionId: 'exec-echo',
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
      executionId: 'exec-echo',
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
      expect(hostEmit).toHaveBeenNthCalledWith(1, 'updateStreamUsage', payload);
      expect(hostEmit).toHaveBeenNthCalledWith(
        2,
        'updateStreamUsage',
        secondPayload,
      );
    } finally {
      detachProjection();
      detachTui();
    }
  });

  it('does not double-count projected usage when CLI projection is first', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    // Regression coverage for #7388: the CLI projection is registered on the
    // hub before the TUI subscription here — the reverse of what
    // `chatSessionController.ts` does today — to prove the echo guard's dedupe
    // does not depend on that registration order. Two distinct usage events
    // are emitted so the guard is proven across a sequence, not just a single
    // isolated pairing.
    const detachProjection = attachCliSessionProgressProjection(hub, wrapped);
    const detachTui = attachTuiRunFactSubscription(hub);
    const storageKey = 'root-cli-projection-first-run' as StorageKey;
    const payload = {
      streamId: root,
      storageKey,
      executionId: 'exec-cli-projection-first',
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
      executionId: 'exec-projector-first',
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
      expect(hostEmit).toHaveBeenNthCalledWith(1, 'updateStreamUsage', payload);
      expect(hostEmit).toHaveBeenNthCalledWith(
        2,
        'updateStreamUsage',
        secondPayload,
      );
    } finally {
      detachTui();
      detachProjection();
    }
  });

  it.each([
    {
      name: 'TUI subscriber is first',
      attach: (hub: SessionEventHub, host: CliRuntimeHost) => {
        const detachTui = attachTuiRunFactSubscription(hub);
        const detachProjection = attachCliSessionProgressProjection(hub, host);
        return () => {
          detachProjection();
          detachTui();
        };
      },
    },
    {
      name: 'CLI projection is first',
      attach: (hub: SessionEventHub, host: CliRuntimeHost) => {
        const detachProjection = attachCliSessionProgressProjection(hub, host);
        const detachTui = attachTuiRunFactSubscription(hub);
        return () => {
          detachTui();
          detachProjection();
        };
      },
    },
  ])('does not duplicate process output when the $name', ({ attach }) => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const detach = attach(hub, wrapped);
    const payload = {
      parentStreamId: root,
      executionId: 'exec-output',
      stdout: 'alpha',
      stderr: 'beta',
    };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'process.output',
          ...payload,
        },
      });

      expect(streams.get().get(root)?.processOutput.get('exec-output')).toEqual(
        {
          stdout: 'alpha',
          stderr: 'beta',
        },
      );
      expect(hostEmit).toHaveBeenCalledWith('updateProcessOutput', payload);
    } finally {
      detach();
    }
  });

  it.each([
    {
      name: 'TUI subscriber is first',
      attach: (hub: SessionEventHub, host: CliRuntimeHost) => {
        const detachTui = attachTuiRunFactSubscription(hub);
        const detachProjection = attachCliSessionProgressProjection(hub, host);
        return () => {
          detachProjection();
          detachTui();
        };
      },
    },
    {
      name: 'CLI projection is first',
      attach: (hub: SessionEventHub, host: CliRuntimeHost) => {
        const detachProjection = attachCliSessionProgressProjection(hub, host);
        const detachTui = attachTuiRunFactSubscription(hub);
        return () => {
          detachTui();
          detachProjection();
        };
      },
    },
  ])(
    'does not duplicate completed-process transcript entries when the $name',
    ({ attach }) => {
      const hub = new SessionEventHub();
      const hostEmit = vi.fn();
      const wrapped = wrapRuntimeHost({
        emit: hostEmit,
        close: async () => {},
      } as unknown as CliRuntimeHost);
      const detach = attach(hub, wrapped);

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
            stdout: 'finished output',
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
        const processEntries =
          slice?.entries.filter((entry) => entry.role === 'process') ?? [];
        expect(processEntries).toHaveLength(1);
        expect(processEntries[0]?.process?.executionId).toBe('exec-a');
        expect(slice?.processOutput.has('exec-a')).toBe(false);
        expect(slice?.activeProcesses).toEqual([runningProcessB]);
        expect(hostEmit).toHaveBeenCalledWith('updateActiveProcesses', {
          parentStreamId: root,
          processes: [runningProcessB],
        });
      } finally {
        detach();
      }
    },
  );

  it('does not duplicate the goalPaused notice when the TUI subscriber is first', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const detachTui = attachTuiRunFactSubscription(hub);
    const detachProjection = attachCliSessionProgressProjection(hub, wrapped);
    const payload = { streamId: root };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'domain',
          key: toRunFactDomainKey('goalPaused'),
          data: payload,
        },
      });

      expect(
        streams
          .get()
          .get(root)
          ?.entries.filter(
            (entry) => entry.text === GOAL_PAUSED_TRANSCRIPT_NOTICE,
          ),
      ).toHaveLength(1);
      expect(hostEmit).toHaveBeenCalledWith('goalPaused', payload);
    } finally {
      detachProjection();
      detachTui();
    }
  });

  it('does not duplicate the goalPaused notice when CLI projection is first', () => {
    const hub = new SessionEventHub();
    const hostEmit = vi.fn();
    const wrapped = wrapRuntimeHost({
      emit: hostEmit,
      close: async () => {},
    } as unknown as CliRuntimeHost);
    const detachProjection = attachCliSessionProgressProjection(hub, wrapped);
    const detachTui = attachTuiRunFactSubscription(hub);
    const payload = { streamId: root };

    try {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'domain',
          key: toRunFactDomainKey('goalPaused'),
          data: payload,
        },
      });

      expect(
        streams
          .get()
          .get(root)
          ?.entries.filter(
            (entry) => entry.text === GOAL_PAUSED_TRANSCRIPT_NOTICE,
          ),
      ).toHaveLength(1);
      expect(hostEmit).toHaveBeenCalledWith('goalPaused', payload);
    } finally {
      detachTui();
      detachProjection();
    }
  });

  it('bridges only transitional metadata events to the snapshot store', () => {
    const snapshotStore = {
      handleProgressEvent: vi.fn(),
    } as unknown as StreamSnapshotStore;
    const wrapped = wrapRuntimeHost(makeHost(), snapshotStore);

    const todos: TodoItem[] = [
      {
        content: 'Write the introduction',
        status: TODO_STATUS.IN_PROGRESS,
        activeForm: 'Writing the introduction',
      },
    ];
    wrapped.emit('updateTodos', { streamId: root, todos });
    expect(streams.get().get(root)?.todos).toEqual(todos);
    expect(snapshotStore.handleProgressEvent).not.toHaveBeenCalled();

    wrapped.emit('updateStreamDescription', {
      streamId: root,
      description: 'search / kimi26T',
    });
    expect(snapshotStore.handleProgressEvent).toHaveBeenCalledWith(
      'updateStreamDescription',
      { streamId: root, description: 'search / kimi26T' },
    );
  });

  it('registers suppressed child streams without switching away from the parent page', () => {
    const wrapped = wrapRuntimeHost(makeHost());
    activeStreamId.set(root);

    wrapped.emit('setActiveStream', {
      streamId: child1,
      suppressViewSwitch: true,
    });

    expect(activeStreamId.get()).toBe(root);
    expect(streams.get().has(child1)).toBe(true);
  });

  it('captures per-stream model identity from task state', () => {
    const wrapped = wrapRuntimeHost(makeHost());

    wrapped.emit('setTaskState', {
      streamId: child1,
      executionId: 'exec-search',
      taskState: {
        agentConfig: {
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
  });

  it('refreshes queued follow-up display when an active follow-up is sent', () => {
    const wrapped = wrapRuntimeHost(makeHost());
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.RUNNING }));
    const queue = ToolUseFollowUpQueue.acquire(root);

    try {
      queue.enqueue({ text: 'Keep the proof under one page.' });
      wrapped.emit('followUpSent', { streamId: root });

      let slice = streams.get().get(root);
      expect(slice?.queuedFollowUps).toBe(1);
      expect(slice?.queuedFollowUpMessages).toEqual([
        'Keep the proof under one page.',
      ]);

      queue.drain();
      wrapped.emit('updateQueuedFollowUps', { streamId: root });

      slice = streams.get().get(root);
      expect(slice?.queuedFollowUps).toBe(0);
      expect(slice?.queuedFollowUpMessages).toEqual([]);
    } finally {
      ToolUseFollowUpQueue.release(root);
    }
  });

  it('keeps latest usage separate from cumulative resume usage', () => {
    const wrapped = wrapRuntimeHost(makeHost());
    const storageKey = 'root-run' as StorageKey;

    wrapped.emit('updateStreamUsage', {
      streamId: root,
      storageKey,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cost: 1,
        cacheReadInputTokens: 30,
      },
    });
    wrapped.emit('updateStreamUsage', {
      streamId: root,
      storageKey,
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        cost: 2,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 7,
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
  });

  it('persists a bounded completed-process transcript before pruning processOutput', () => {
    const wrapped = wrapRuntimeHost(makeHost());
    const lines = Array.from(
      { length: COMPLETED_PROCESS_TAIL_LINES + 2 },
      (_, index) => `line ${index + 1}`,
    ).join('\n');

    // Seed: two live processes with tail output.
    wrapped.emit('updateActiveProcesses', {
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
    });
    wrapped.emit('updateProcessOutput', {
      parentStreamId: root,
      executionId: 'exec-a',
      stdout: lines,
      stderr: 'stderr tail',
    });
    wrapped.emit('updateProcessOutput', {
      parentStreamId: root,
      executionId: 'exec-b',
      stdout: 'B',
      stderr: '',
    });
    expect(streams.get().get(root)?.processOutput.size).toBe(2);

    // exec-a finishes: its output buffer must be dropped on the next
    // active-processes update, after a durable transcript entry is added.
    wrapped.emit('updateActiveProcesses', {
      parentStreamId: root,
      processes: [
        { kind: 'process', executionId: 'exec-b', agentName: 'bash' },
      ],
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
      STREAM_STATUS.WAITING,
    );
    expect(split.finalized).toContain(processEntries[0]);
    expect(split.pending).not.toContain(processEntries[0]);
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

describe('focusCycle', () => {
  it('Ctrl-A cycles through siblings then wraps back to the parent', () => {
    activeStreamId.set(root);
    setParentStream(child1, root);
    setParentStream(child2, root);
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.RUNNING }));
    patchStream(child2, (s) => ({ ...s, status: STREAM_STATUS.RUNNING }));
    patchStream(root, (s) => ({
      ...s,
      // Only subagents own a stream tab, so both live siblings are modeled as
      // subagents here — a background process is never itself a focus target.
      activeSubagents: [
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
      ],
    }));
    // root → first descendant.
    expect(nextFocusForward()).toBe(child1);
    // child1 → next sibling resolved through the parent's descendant list.
    activeStreamId.set(child1);
    expect(nextFocusForward()).toBe(child2);
    // child2 (last sibling) → wrap back to parent.
    activeStreamId.set(child2);
    expect(nextFocusForward()).toBe(root);
  });

  it('Ctrl-A can still focus an inactive child stream with retained history', () => {
    activeStreamId.set(root);
    setParentStream(child1, root);
    patchStream(root, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));
    patchStream(child1, (s) => ({ ...s, status: STREAM_STATUS.WAITING }));

    expect(nextFocusForward()).toBe(child1);
  });

  it('Ctrl-B returns to the parent and bottoms out at root', () => {
    setParentStream(child1, root);
    activeStreamId.set(child1);
    expect(nextFocusBack()).toBe(root);
    activeStreamId.set(root);
    expect(nextFocusBack()).toBeUndefined();
  });
});
