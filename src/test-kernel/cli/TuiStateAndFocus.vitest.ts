// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startCompactionActivity } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import {
  activeStreamId,
  beginWorkPlanReaderRequest,
  closeInfoPane,
  type ConversationEntry,
  finishWorkPlanReaderRequest,
  focusStream,
  foregroundReader,
  infoPane,
  openInfoPane,
  rootRunPending,
  rootRunStartAvailable,
  rootRunStreamId,
  rootStreamId,
  removeStream,
  resetCliState,
  patchStream,
  setTransientNotice,
  setStreamStatusInCliState,
  streams,
  transientNotice,
} from '@cli/chat/tui/state/cliState';
import {
  allocateConversationBottomPanelRows,
  allocateConversationPanelRows,
  allocateMiddleRows,
  allocateSidePanelRows,
  shouldShowTodosPlanPanel,
  staticTranscriptRowBudget,
} from '@cli/chat/tui/appLayout';
import { focusedChildFollowUpRoute } from '@cli/chat/tui/state/focusedChildFollowUp';
import {
  activeSubagentsFor,
  projectChildRoster,
  childStreamEntries,
  focusOrderDescendants,
  isChildStreamRemoved,
  parentStream,
  retainedChildStreamsFor,
  setParentStream,
  subagentExecutionLabels,
  visibleSubagentRows,
} from '@cli/chat/tui/state/childExecutions';
import {
  finalizeSettledPrefix,
  syncStreamLog,
} from '@cli/chat/tui/state/subscribeStreamLog';
import { transcriptViewportKey } from '@cli/chat/tui/state/transcriptViewportMode';
import { projectStreamTranscript } from '@cli/chat/tui/state/transcriptProjection';
import { subscribeStreamStatus } from '@cli/chat/tui/state/subscribeStreamStatus';
import { attachSessionSignalsAdapter } from '@cli/chat/tui/state/sessionSignalsAdapter';
import {
  estimateTranscriptEntryRows,
  selectTranscriptEntriesForViewport,
} from '@cli/chat/tui/panes/transcriptViewport';
import { splitTranscriptEntries } from '@cli/chat/tui/panes/transcriptEntries';
import { transcriptEntryLayout } from '@cli/chat/tui/panes/transcriptEntryLayout';
import { renderAnsiMarkdown } from '@cli/chat/tui/render/ansiMarkdown';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanStopActiveRun,
  chatTuiCanStopVisibleRun,
  chatTuiCanStartRootRun,
  chatTuiCanSelectModel,
  chatTuiSigintAction,
  TuiSession,
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
import { stripOrchestratorFollowup } from '@shared/subagentFollowup';
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
  type StorageKey,
  type StreamPhase,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import type { StreamTransitionCause } from '@shared/streams/streamStatus';
import { clearAllStreamStatusesForTest } from '@test/support/streamStatusTestUtils';
import {
  createRunTrace,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';

const root = 'root' as StreamTabId;
const child1 = 'child-1' as StreamTabId;
const child2 = 'child-2' as StreamTabId;
const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

function orderedSessionDescendants(parent: StreamTabId): StreamTabId[] {
  return [
    ...focusOrderDescendants(parent, childStreamEntries.get(), streams.get()),
  ];
}

function activeRows(parent: StreamTabId): readonly ActiveChildInfo[] {
  return activeSubagentsFor(parent, childStreamEntries.get(), streams.get());
}

function retainedRows(parent: StreamTabId): readonly ActiveChildInfo[] {
  return retainedChildStreamsFor(
    parent,
    childStreamEntries.get(),
    streams.get(),
  );
}

function visibleRows(parent: StreamTabId): readonly ActiveChildInfo[] {
  return visibleSubagentRows(parent, childStreamEntries.get(), streams.get());
}

function streamEntries(streamId: StreamTabId): readonly ConversationEntry[] {
  return streams.get().get(streamId)?.entries ?? [];
}

function entryTexts(streamId: StreamTabId): string[] {
  return streamEntries(streamId).map((entry) => entry.text);
}

/** Run trace bound to the default session's transcript store, which the
 *  `CLI transcript state` suite clears before every test. */
function runTrace(
  streamId: StreamTabId,
): ReturnType<typeof createRunTrace>['trace'] {
  return createRunTrace(streamId, defaultSession().transcripts).trace;
}

/** The run-trace logger returned by {@link runTrace}. */
type TraceLogger = ReturnType<typeof runTrace>;

/** Drive a stream to a phase through the production fact-application path. */
function setStatus(streamId: StreamTabId, status: StreamPhase): void {
  setStreamStatusInCliState({ streamId, status });
}

function transitionStatus(
  streamId: StreamTabId,
  phase: StreamPhase,
  reason: StreamTransitionCause,
): boolean {
  return defaultSession().status.transition(streamId, phase, reason);
}

/** Mint a stream slice without a status of its own (activation step "A"). */
function mintSlice(streamId: StreamTabId): void {
  patchStream(streamId, (slice) => ({ ...slice }));
}

/** Roster row for a child agent whose identity mirrors its agent name. */
function childRosterRow(
  agentName: string,
  childStreamId: StreamTabId,
  status?: StreamPhase,
  executionId = 'child-exec-1',
) {
  return {
    executionId,
    agentName,
    identity: { kind: 'agent' as const, agent: agentName },
    childStreamId,
    status,
  };
}

function emitStageStart(
  hub: SessionEventHub,
  streamId: StreamTabId,
  stage: {
    id: string;
    label: string;
    kind: 'phase' | 'round';
    index?: number;
    total?: number;
  },
): void {
  hub.emit({
    scope: 'run',
    streamId,
    event: { type: 'stage.start', ...stage },
  });
}

function emitRunConfig(
  hub: SessionEventHub,
  streamId: StreamTabId,
  executionId: ExecutionId,
  files: { input: string[]; context: string[]; output: string[] } = {
    input: [],
    context: [],
    output: [],
  },
): void {
  hub.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'run.config',
      streamId,
      executionId,
      config: {
        agent: 'search',
        agentCategory: AgentCategory.ToolUse,
        model: 'kimi26T',
        instruction: 'Check the enumeration independently.',
        inputFiles: files.input,
        contextFiles: files.context,
        mediaFiles: [],
        outputFiles: files.output,
        editedFile: null,
        editedFiles: [],
        toolConfig: DEFAULT_TOOL_CONFIG,
        memories: [],
        workingDirectory: undefined,
      },
    },
  });
}

function emitUsage(
  hub: SessionEventHub,
  streamId: StreamTabId,
  storageKey: StorageKey,
  usage: ExtendedTokenUsageStats,
  executionId?: ExecutionId,
): void {
  hub.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'usage',
      payload: {
        streamId,
        storageKey,
        ...(executionId === undefined ? {} : { executionId }),
        usage,
      },
    },
  });
}

function logUserMessage(trace: TraceLogger, text: string): void {
  trace.info(text, { messageType: MESSAGE_TYPES.USER_MESSAGE });
}

function logModelResponse(trace: TraceLogger, text: string): void {
  trace.info(text, { messageType: MESSAGE_TYPES.MODEL_RESPONSE });
}

function logModelError(trace: TraceLogger, text: string, data?: unknown): void {
  trace.error(text, {
    messageType: MESSAGE_TYPES.ERROR,
    ...(data === undefined ? {} : { data }),
  });
}

function logToolUse(
  trace: TraceLogger,
  data: unknown,
  text = 'tool activity',
): void {
  trace.info(text, { messageType: MESSAGE_TYPES.TOOL_USE, data });
}

/** Synthetic local-transcript entry as written by the local echo path. */
function localSyntheticEntry(
  id: string,
  role: 'user' | 'assistant' | 'error',
  text: string,
  syntheticAfterSeq: number,
  syntheticAfterSettlementSeqNo: number,
) {
  return {
    id,
    role,
    text,
    finalized: true,
    synthetic: true,
    syntheticKind: 'local',
    syntheticAfterSeq,
    syntheticAfterSettlementSeqNo,
  } as const;
}

/** Mark a stream as a native tool-use agent that can accept child follow-ups. */
function markToolUseAgent(streamId: StreamTabId): void {
  patchStream(streamId, (slice) => ({
    ...slice,
    identity: { kind: 'agent', agent: 'critic' },
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    category: AgentCategory.ToolUse,
  }));
}

/** Mark a stream slice as workflow-category. */
function markWorkflow(streamId: StreamTabId): void {
  patchStream(streamId, (slice) => ({
    ...slice,
    category: AgentCategory.Workflow,
  }));
}

/** Unfinalized tool-row entry with empty render text fields. */
function toolEntry(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  options: { outputText?: string; status?: 'in_progress' | 'completed' } = {},
) {
  return {
    id,
    role: 'tool',
    text: '',
    finalized: false,
    toolUse: {
      toolName,
      errorText: '',
      outputText: options.outputText ?? '',
      userInstructionText: '',
      input,
      isError: false,
      isUserFeedback: false,
      headerSummary: '',
      status: options.status ?? 'completed',
    },
  } as const;
}

/** Run `body` with a TUI run-fact subscription attached to a fresh hub. */
function withRunFacts(
  body: (hub: SessionEventHub, session: SessionHandle) => void,
): void {
  const hub = new SessionEventHub();
  const snapshots = new StreamSnapshotStore();
  const session = new SessionHandle({
    events: hub,
    snapshots,
    transcripts: StreamLogStore.ephemeral('TUI session signals test'),
  });
  const detach = attachSessionSignalsAdapter({
    events: hub,
    session,
    snapshots,
  });
  try {
    body(hub, session);
  } finally {
    detach();
    snapshots.evictAll();
  }
}

/** Run `body` with the stream-status subscription attached. */
function withStreamStatus(body: () => void): void {
  const dispose = subscribeStreamStatus();
  try {
    body();
  } finally {
    dispose();
  }
}

afterEach(() => {
  clearAllStreamStatusesForTest(defaultSession().status);
  // A reset retires every stream id it clears, so an id reused by the next
  // test would stay refused by the status/focus owners. The second reset has
  // an empty map to retire and leaves no retired identity behind.
  resetCliState();
  resetCliState();
});

describe('cliState stream, focus, and child-edge fields', () => {
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

  it('initialises every new slice with empty subagent/todo/plan/bypass defaults', () => {
    setStatus(root, STREAM_PHASE.RUNNING);
    const slice = streams.get().get(root);
    expect(slice).toBeDefined();
    expect(activeRows(root)).toEqual([]);
    expect(slice?.todos).toEqual([]);
    expect(slice?.plan).toBeNull();
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
    setStatus(child1, STREAM_PHASE.RUNNING);
    removeStream(child1);
    expect(parentStream.get().has(child1)).toBe(false);
    expect(parentStream.get().get(child2)).toBe(root);

    // Removing the parent prunes every edge that pointed at it.
    setStatus(root, STREAM_PHASE.RUNNING);
    removeStream(root);
    expect(parentStream.get().has(child2)).toBe(false);
  });

  it('refuses focus for a removed stream identity', () => {
    setStatus(child1, STREAM_PHASE.RUNNING);
    focusStream(child1);
    expect(activeStreamId.get()).toBe(child1);

    removeStream(child1);
    expect(activeStreamId.get()).toBeUndefined();

    // A fact that arrives after the row is gone must not pull the view back
    // onto it, with or without an existing focus.
    focusStream(child1);
    expect(activeStreamId.get()).toBeUndefined();
    focusStream(child1, { onlyIfUnset: true });
    expect(activeStreamId.get()).toBeUndefined();
  });

  it('closes a foreground reader when its captured stream is removed', () => {
    mintSlice(child1);
    finishWorkPlanReaderRequest(beginWorkPlanReaderRequest(child1));

    removeStream(child1);

    expect(foregroundReader.get()).toBeUndefined();
  });

  it('refuses focus for a stream retired by a session reset', () => {
    setStatus(root, STREAM_PHASE.RUNNING);
    resetCliState();

    focusStream(root, { onlyIfUnset: true });
    expect(activeStreamId.get()).toBeUndefined();

    // The next state lifetime owns the identity again once a patch
    // re-registers the row.
    mintSlice(root);
    focusStream(root);
    expect(activeStreamId.get()).toBe(root);
  });

  it('keeps the current focus when a later stream only claims an unset slot', () => {
    setStatus(root, STREAM_PHASE.RUNNING);
    setStatus(child1, STREAM_PHASE.RUNNING);
    focusStream(root);
    focusStream(child1, { onlyIfUnset: true });
    expect(activeStreamId.get()).toBe(root);
  });

  it('removes stale child rows when a stream is removed', () => {
    activeStreamId.set(root);
    // Roster-first (rule 3): registers both the retained history row and
    // active membership, then the explicit edge arrives.
    projectChildRoster(root, [
      childRosterRow('critic', child1, STREAM_PHASE.RUNNING, 'agent-1'),
    ]);
    setParentStream(child1, root);
    setStatus(child1, STREAM_PHASE.WAITING);

    expect(orderedSessionDescendants(root)[0]).toBe(child1);

    removeStream(child1);

    expect(retainedRows(root)).toEqual([]);
    expect(activeRows(root)).toEqual([]);
    expect(visibleRows(root)).toEqual([]);
    expect(isChildStreamRemoved(child1)).toBe(true);
    expect(orderedSessionDescendants(root)[0]).toBeUndefined();
  });

  it('updates retained child rows when a failed subagent leaves the active list', () => {
    withStreamStatus(() => {
      projectChildRoster(root, [
        childRosterRow('codex', child1, STREAM_PHASE.RUNNING, 'agent-1'),
      ]);
      // A later, empty roster clears active membership; the retained row
      // survives and its status is read live from the child's own slice.
      projectChildRoster(root, []);

      expect(subagentExecutionLabels.get().get('agent-1')).toBe('codex');

      transitionStatus(child1, STREAM_PHASE.FAILED, 'restart-repair');

      expect(activeRows(root)).toEqual([]);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.FAILED);
      expect(visibleRows(root)).toMatchObject([
        {
          executionId: 'agent-1',
          childStreamId: child1,
          status: STREAM_PHASE.FAILED,
        },
      ]);
    });
  });

  it('treats a null-parent update as child promotion to top-level', () => {
    setParentStream(child1, root);
    expect(parentStream.get().get(child1)).toBe(root);

    setParentStream(child1, null);

    expect(parentStream.get().has(child1)).toBe(false);
  });

  it('projects phase stages onto the run slice and leaves rounds alone', () => {
    withRunFacts((hub) => {
      emitStageStart(hub, child1, {
        id: 'phase-2',
        label: 'Reduce',
        kind: 'phase',
        index: 1,
        total: 3,
      });

      expect(streams.get().get(child1)?.stage).toEqual({
        kind: 'phase',
        label: 'Reduce',
        index: 1,
        total: 3,
      });

      emitStageStart(hub, root, {
        id: 'round-2',
        label: 'round 2',
        kind: 'round',
        index: 1,
        total: 4,
      });

      expect(streams.get().get(root)?.stage).toEqual({
        kind: 'round',
        index: 1,
        total: 4,
      });
    });
  });

  it('keeps a dynamically opened phase positionless', () => {
    withRunFacts((hub) => {
      emitStageStart(hub, child1, {
        id: 'phase-x',
        label: 'Cleanup',
        kind: 'phase',
      });

      expect(streams.get().get(child1)?.stage).toEqual({
        kind: 'phase',
        label: 'Cleanup',
      });
    });
  });

  it('registers subagent parent edges when active child rows arrive', () => {
    withRunFacts((hub) => {
      activeStreamId.set(root);
      setStatus(child1, STREAM_PHASE.RUNNING);

      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          parentStreamId: root,
          items: [
            childRosterRow('critic', child1, STREAM_PHASE.RUNNING, 'agent-1'),
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
        }),
      ).toBe('root-scrollback');
    });
  });
});

describe('CLI TUI row allocation', () => {
  it('keeps foreground approval and form surfaces inside the middle row budget', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: true,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(1);
    expect(layout.foregroundRows).toBe(18);
  });

  it('returns disabled input rows to tiny foreground surfaces', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: true,
      inputVisible: false,
      reverseSearchOpen: false,
      rows: 10,
      slashPaletteOpen: false,
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

  it('uses the whole middle region for the transcript without foreground UI', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(19);
    expect(layout.foregroundRows).toBe(0);
  });

  it('reserves queued follow-up panel rows above the stable input chrome', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      queuedFollowUpPanelRows: 3,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: false,
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

  it('reserves rows for reverse-search input chrome', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: true,
      rows: 24,
      slashPaletteOpen: false,
    });

    expect(layout.transcriptRows).toBe(14);
    expect(layout.foregroundRows).toBe(0);
  });

  it('returns former header rows to the transcript when slash palette is open', () => {
    const layout = allocateMiddleRows({
      foregroundOpen: false,
      reverseSearchOpen: false,
      rows: 24,
      slashPaletteOpen: true,
    });

    expect(layout.transcriptRows).toBe(6);
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
    {
      transcriptRows: 8,
      expected: {
        bottomPanelRows: 7,
        conversationRows: 1,
        sessionPanelRows: 4,
        todosPlanRows: 3,
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
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: false,
        todosPlanContentRows: 5,
        transcriptRows: 1,
      }),
    ).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 1,
        childListFocused: true,
        todosPlanContentRows: 0,
        transcriptRows: 1,
      }),
    ).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });

    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 3,
        childListFocused: true,
        minimumSessionPanelRows: 3,
        todosPlanContentRows: 0,
        transcriptRows: 2,
      }),
    ).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  it('keeps the child list collapsed until it receives focus', () => {
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: false,
        todosPlanContentRows: 0,
        transcriptRows: 6,
      }),
    ).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });

    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: true,
        todosPlanContentRows: 0,
        transcriptRows: 6,
      }),
    ).toEqual({
      bottomPanelRows: 3,
      sessionPanelRows: 3,
      todosPlanRows: 0,
    });
  });

  it('reserves a separator row above the todos panel', () => {
    // 2 todos + separator = 3 rows when the transcript allows it.
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 0,
        childListFocused: false,
        todosPlanContentRows: 2,
        transcriptRows: 8,
      }),
    ).toMatchObject({ bottomPanelRows: 3, todosPlanRows: 3 });
  });

  it('borrows a focused child-list row so an active todo stays visible', () => {
    // Many children plus one todo under the 10-row cap: the proportional
    // split grants todos a single row, too small for separator plus content,
    // so one row shifts from the ample child list instead.
    const allocation = allocateConversationBottomPanelRows({
      maxRows: 10,
      sessionCount: 11,
      childListFocused: true,
      todosPlanContentRows: 1,
      transcriptRows: 30,
    });
    expect(allocation.todosPlanRows).toBe(2);
    expect(allocation.sessionPanelRows).toBeGreaterThanOrEqual(2);
    expect(allocation.bottomPanelRows).toBe(
      allocation.sessionPanelRows + allocation.todosPlanRows,
    );
  });

  it('hands a lone todos row back instead of rendering a dead separator', () => {
    // The grant would be exactly one row — too small for separator + content.
    const allocation = allocateConversationBottomPanelRows({
      maxRows: 10,
      sessionCount: 0,
      childListFocused: false,
      todosPlanContentRows: 4,
      transcriptRows: 2,
    });
    expect(allocation).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  it('preserves todo content when the focused child list can yield one row', () => {
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 11,
        childListFocused: true,
        todosPlanContentRows: 1,
        transcriptRows: 20,
      }),
    ).toEqual({
      bottomPanelRows: 10,
      sessionPanelRows: 8,
      todosPlanRows: 2,
    });
  });

  it('does not allocate session rows without transcript space', () => {
    expect(
      allocateConversationBottomPanelRows({
        maxRows: 10,
        sessionCount: 2,
        childListFocused: false,
        todosPlanContentRows: 5,
        transcriptRows: 0,
      }),
    ).toEqual({
      bottomPanelRows: 0,
      sessionPanelRows: 0,
      todosPlanRows: 0,
    });
  });

  it('keeps unfinished todo and plan chrome across stream phases', () => {
    const openTodo = {
      content: 'Check the live proof',
      activeForm: 'Checking the live proof',
      status: TODO_STATUS.IN_PROGRESS,
    } satisfies TodoItem;
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        todos: [openTodo],
      }),
    ).toBe(true);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: true,
        todos: [],
      }),
    ).toBe(true);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        todos: [openTodo],
      }),
    ).toBe(true);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        todos: [openTodo],
      }),
    ).toBe(true);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: true,
        hasPlan: false,
        todos: [openTodo],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: false,
        todos: [],
      }),
    ).toBe(false);
    expect(
      shouldShowTodosPlanPanel({
        foregroundOpen: false,
        hasPlan: true,
        todos: [
          {
            content: 'Finish the old goal',
            activeForm: 'Finishing the old goal',
            status: TODO_STATUS.COMPLETED,
          },
        ],
      }),
    ).toBe(true);
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
    expect(rootRunStartAvailable.get()).toBe(false);
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
    expect(rootRunStartAvailable.get()).toBe(false);

    session.markRunCompleted();

    expect(rootRunStreamId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(false);
    expect(rootRunStartAvailable.get()).toBe(true);
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
    setStatus(root, STREAM_PHASE.WAITING);
    setStatus(child1, STREAM_PHASE.WAITING);
    markToolUseAgent(child1);
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
    setStatus(root, STREAM_PHASE.WAITING);
    projectChildRoster(root, [
      childRosterRow('critic', child1, STREAM_PHASE.COMPLETED),
    ]);
    setStatus(child1, STREAM_PHASE.RUNNING);
    markToolUseAgent(child1);
    setParentStream(child1, root);

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'accept',
      streamId: child1,
    });
  });

  // The roster row carries no status of its own: `reconstruct` resolves every
  // child row's status from the stream status map, so a roster snapshot that
  // still says RUNNING cannot keep a stopped child accepting follow-ups.
  it('routes focused child follow-ups from the stream status, not the roster row', () => {
    setStatus(root, STREAM_PHASE.WAITING);
    projectChildRoster(root, [
      childRosterRow('critic', child1, STREAM_PHASE.RUNNING),
    ]);
    setStatus(child1, STREAM_PHASE.CANCELLED);
    markToolUseAgent(child1);
    setParentStream(child1, root);

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'reject',
      streamId: child1,
    });
  });

  const childCapabilityStatuses = [
    STREAM_PHASE.RUNNING,
    STREAM_PHASE.WAITING,
    STREAM_PHASE.COMPLETED,
    STREAM_PHASE.CANCELLED,
    STREAM_PHASE.FAILED,
  ] as const;
  const terminalChildStatuses = [
    STREAM_PHASE.COMPLETED,
    STREAM_PHASE.CANCELLED,
    STREAM_PHASE.FAILED,
  ] as const;

  it.each([
    {
      name: 'tool-use agent running',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status: STREAM_PHASE.RUNNING,
      expected: 'accept',
    },
    {
      name: 'tool-use agent waiting',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status: STREAM_PHASE.WAITING,
      expected: 'accept',
    },
    ...childCapabilityStatuses.map((status) => ({
      name: `structured single-cycle call ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.ToolUse,
      status,
      expected: 'reject',
    })),
    ...childCapabilityStatuses.map((status) => ({
      name: `workflow agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'review-workflow' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.Workflow,
      status,
      expected: 'reject',
    })),
    ...childCapabilityStatuses.map((status) => ({
      name: `multi-agent workflow ${status}`,
      identity: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'review-workflow',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.Workflow,
      status,
      expected: 'reject',
    })),
    ...childCapabilityStatuses.map((status) => ({
      name: `background bash process ${status}`,
      identity: { kind: 'process' as const, tool: 'bash' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category: AgentCategory.ToolUse,
      status,
      expected: 'reject',
    })),
    ...childCapabilityStatuses.map((status) => ({
      name: `terminal-backed agent ${status}`,
      identity: {
        kind: 'agent' as const,
        agent: 'codex',
        tool: 'codex',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
      category: AgentCategory.ToolUse,
      status,
      expected: 'reject',
    })),
    ...terminalChildStatuses.map((status) => ({
      name: `tool-use agent ${status}`,
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
      status,
      expected: 'reject',
    })),
  ])('gates the focused child composer for $name', (fixture) => {
    setStatus(child1, fixture.status);
    patchStream(child1, (slice) => ({
      ...slice,
      identity: fixture.identity,
      userFollowUpSupport: fixture.userFollowUpSupport,
      category: fixture.category,
    }));
    setParentStream(child1, root);

    expect(
      focusedChildFollowUpRoute({
        activeStreamId: child1,
        parentStream: parentStream.get(),
        streams: streams.get(),
      }),
    ).toEqual({ kind: fixture.expected, streamId: child1 });
  });

  it.each([
    {
      name: 'identity',
      identity: undefined,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: AgentCategory.ToolUse,
    },
    {
      name: 'runtime support',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: undefined,
      category: AgentCategory.ToolUse,
    },
    {
      name: 'category',
      identity: { kind: 'agent' as const, agent: 'critic' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      category: undefined,
    },
  ])('fails closed when child $name metadata is missing', (fixture) => {
    setStatus(child1, STREAM_PHASE.RUNNING);
    patchStream(child1, (slice) => ({
      ...slice,
      identity: fixture.identity,
      userFollowUpSupport: fixture.userFollowUpSupport,
      category: fixture.category,
    }));
    setParentStream(child1, root);

    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({ kind: 'none' });
    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'reject',
      streamId: child1,
    });
  });

  it('fails closed when focused child status is missing while leaving root routing unchanged', () => {
    mintSlice(child1);
    markToolUseAgent(child1);
    setParentStream(child1, root);

    activeStreamId.set(child1);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
      kind: 'reject',
      streamId: child1,
    });
    activeStreamId.set(root);
    expect(chatTuiFocusedChildFollowUpRoute()).toEqual({ kind: 'none' });
  });

  it('mirrors running child status events into focused child routing', () => {
    withStreamStatus(() => {
      setStatus(root, STREAM_PHASE.WAITING);
      projectChildRoster(root, [
        childRosterRow('critic', child1, STREAM_PHASE.COMPLETED),
      ]);
      setStatus(child1, STREAM_PHASE.CANCELLED);
      markToolUseAgent(child1);
      setParentStream(child1, root);

      transitionStatus(child1, STREAM_PHASE.RUNNING, 'restart-repair');

      activeStreamId.set(child1);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.RUNNING);
      expect(retainedRows(root)[0]?.status).toBe(STREAM_PHASE.RUNNING);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });
    });
  });

  it('mirrors stopped child status events into focused child routing', () => {
    withStreamStatus(() => {
      setStatus(root, STREAM_PHASE.WAITING);
      projectChildRoster(root, [
        childRosterRow('critic', child1, STREAM_PHASE.RUNNING),
      ]);
      setStatus(child1, STREAM_PHASE.RUNNING);
      markToolUseAgent(child1);
      setParentStream(child1, root);

      transitionStatus(child1, STREAM_PHASE.CANCELLED, 'restart-repair');

      activeStreamId.set(child1);
      expect(streams.get().get(child1)?.status).toBe(STREAM_PHASE.CANCELLED);
      expect(retainedRows(root)[0]?.status).toBe(STREAM_PHASE.CANCELLED);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'reject',
        streamId: child1,
      });
    });
  });

  it('returns a focused attached child to its immediate owner on lifecycle completion', () => {
    withStreamStatus(() => {
      // The owner must be a row of the current state lifetime: focus never
      // lands on a stream identity retired by an earlier `resetCliState`.
      setStatus(root, STREAM_PHASE.RUNNING);
      setParentStream(child1, root);
      activeStreamId.set(child1);

      expect(transitionStatus(child1, STREAM_PHASE.RUNNING, 'lifecycle')).toBe(
        true,
      );
      expect(
        transitionStatus(child1, STREAM_PHASE.COMPLETED, 'lifecycle'),
      ).toBe(true);
      expect(activeStreamId.get()).toBe(root);
    });
  });

  it('returns a user-stopped focused child to its immediate owner', () => {
    withStreamStatus(() => {
      setStatus(root, STREAM_PHASE.RUNNING);
      setParentStream(child1, root);
      activeStreamId.set(child1);

      expect(transitionStatus(child1, STREAM_PHASE.RUNNING, 'lifecycle')).toBe(
        true,
      );
      expect(
        transitionStatus(child1, STREAM_PHASE.CANCELLED, 'user-stop'),
      ).toBe(true);
      expect(activeStreamId.get()).toBe(root);
    });
  });

  it('does not auto-return for WAITING, repair, unrelated, or detached status events', () => {
    withStreamStatus(() => {
      const detachedChild = 'detached-child' as StreamTabId;
      setParentStream(child1, root);

      transitionStatus(child1, STREAM_PHASE.RUNNING, 'lifecycle');
      activeStreamId.set(child1);
      transitionStatus(child1, STREAM_PHASE.WAITING, 'wait');
      expect(activeStreamId.get()).toBe(child1);

      transitionStatus(child2, STREAM_PHASE.RUNNING, 'lifecycle');
      transitionStatus(child2, STREAM_PHASE.FAILED, 'lifecycle');
      expect(activeStreamId.get()).toBe(child1);

      transitionStatus(child1, STREAM_PHASE.FAILED, 'restart-repair');
      expect(activeStreamId.get()).toBe(child1);

      transitionStatus(detachedChild, STREAM_PHASE.RUNNING, 'lifecycle');
      activeStreamId.set(detachedChild);
      transitionStatus(detachedChild, STREAM_PHASE.COMPLETED, 'lifecycle');
      expect(activeStreamId.get()).toBe(detachedChild);
    });
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

describe('finalizeSettledPrefix', () => {
  function tool(id: string, status: 'in_progress' | 'completed') {
    return toolEntry(id, 'Bash', {}, { status });
  }

  function assistant(id: string, pendingEmbeddedSubagentFollowup = false) {
    return {
      id,
      role: 'assistant',
      text: id,
      ...(pendingEmbeddedSubagentFollowup
        ? { pendingEmbeddedSubagentFollowup }
        : {}),
      finalized: false,
    } as const;
  }

  function finalizedIds(
    entries: readonly { id: string; finalized: boolean }[],
  ): string[] {
    return entries.filter((entry) => entry.finalized).map((entry) => entry.id);
  }

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
  // read and write the default session's `transcripts` store (#7694). Clear
  // it in place here so store-backed tests need no reset of their own.
  beforeEach(async () => {
    await defaultSession().transcripts.clear();
  });

  it('restores the latest active skills per stream and clears malformed snapshots', () => {
    patchStream(root, (slice) => ({
      ...slice,
      category: AgentCategory.ToolUse,
    }));
    patchStream(child1, (slice) => ({
      ...slice,
      category: AgentCategory.ToolUse,
    }));
    const logger = runTrace(root);
    logger.emit({
      type: 'skills.snapshot',
      skills: [
        {
          name: 'proof-audit',
          description: 'Check proof steps.',
          source: 'project',
        },
      ],
    });

    syncStreamLog(root);
    syncStreamLog(child1);
    expect(streams.get().get(root)?.activeSkills).toMatchObject([
      { name: 'proof-audit', source: 'project' },
    ]);
    expect(streams.get().get(child1)?.activeSkills).toEqual([]);

    resetCliState();
    patchStream(root, (slice) => ({
      ...slice,
      category: AgentCategory.ToolUse,
    }));
    syncStreamLog(root);
    expect(streams.get().get(root)?.activeSkills).toMatchObject([
      { name: 'proof-audit' },
    ]);

    defaultSession()
      .transcripts.get(root)
      ?.appendSettled({
        id: 'malformed-skills',
        type: 'log',
        level: 'info',
        timestamp: 2,
        messageType: MESSAGE_TYPES.ACTIVE_SKILLS,
        data: { skills: [{ path: '/secret' }] },
      });
    syncStreamLog(root);
    expect(streams.get().get(root)?.activeSkills).toEqual([]);
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

  it('renders typed loaded images once and excludes ordinary file lists', () => {
    const logger = runTrace(root);
    logger.domain({
      key: 'filesLoaded',
      data: {
        category: 'all',
        entries: [
          {
            path: '/private/tmp/loaded.png',
            ok: true,
            media: {
              kind: 'image',
              mimeType: 'image/png',
              sizeBytes: 8704,
            },
          },
          {
            path: '/private/tmp/loaded.png',
            ok: true,
            media: {
              kind: 'image',
              mimeType: 'image/png',
              sizeBytes: 8704,
            },
          },
          {
            path: '/private/tmp/paper.pdf',
            ok: true,
            media: {
              kind: 'image',
              mimeType: 'application/pdf',
              sizeBytes: 8192,
            },
          },
          {
            path: '/private/tmp/audio.wav',
            ok: true,
            media: {
              kind: 'audio',
              mimeType: 'audio/wav',
              sizeBytes: 4096,
            },
          },
          {
            path: 'paper.tex',
            ok: true,
            source: 'inputFiles',
          },
        ],
      },
    });

    syncStreamLog(root);
    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'media',
      finalized: true,
      images: [
        { path: '/private/tmp/loaded.png', sizeBytes: 8704 },
        { path: '/private/tmp/paper.pdf', sizeBytes: 8192 },
      ],
    });
    expect(transcriptEntryLayout(entries[0]).lines).toEqual([
      '› [image] /private/tmp/loaded.png (8.5 KiB)',
      '› [image] /private/tmp/paper.pdf (8 KiB)',
    ]);
  });

  it('summarizes subagent protocol continuations in the visible transcript', () => {
    const logger = runTrace(root);
    logUserMessage(logger, 'Please solve the problem.');
    logUserMessage(
      logger,
      '<subagent-result id="abc" agent="review" category="toolUse" status="completed">\nDone.\n</subagent-result>',
    );

    syncStreamLog(root);

    expect(entryTexts(root)).toEqual([
      'Please solve the problem.',
      '✓ review completed',
    ]);
  });

  it('summarizes embedded subagent progress blocks in assistant transcript text', () => {
    const logger = runTrace(root);
    logModelResponse(
      logger,
      [
        'Waiting for the child.',
        '<subagent-progress id="abc" agent="prover" type="todos">',
        '[{"content":"check","status":"completed"},{"content":"prove","status":"in_progress"}]',
        '</subagent-progress>',
        '<subagent-progress id="abc" agent="prover" type="activity">Subagent prover is proving completeness.</subagent-progress>',
      ].join('\n'),
    );

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entryTexts(root)).toEqual([
      [
        'Waiting for the child.',
        '⟳ prover · todos · 1 done, 1 active, 0 pending',
        '⟳ prover · Subagent prover is proving completeness.',
      ].join('\n'),
    ]);
    expect(entries[0]?.text).not.toContain('<subagent-progress');
  });

  it('normalizes common HTML before assistant text reaches the live transcript', () => {
    const logger = runTrace(root);
    logModelResponse(
      logger,
      '<h3>Verification Report</h3>The proof is <b>fully verified</b>.',
    );

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entryTexts(root)).toEqual([
      '### Verification Report\n\nThe proof is **fully verified**.',
    ]);
    expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.MODEL_RESPONSE);
    expect(entries[0]?.text).not.toContain('<h3>');
    expect(entries[0]?.text).not.toContain('<b>');
  });

  it('bounds long subagent result responses in the visible transcript', () => {
    const logger = runTrace(root);
    const response = Array.from(
      { length: 20 },
      (_, index) => `proof line ${index + 1}`,
    ).join('\n');
    logUserMessage(
      logger,
      [
        '<subagent-result id="abc" agent="prover" category="toolUse" status="completed">',
        '<wall-time>2m</wall-time>',
        '<response>',
        response,
        '</response>',
        '</subagent-result>',
      ].join('\n'),
    );

    syncStreamLog(root);

    const entries = streamEntries(root);
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
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed');

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'error',
      text: 'Model request failed',
      finalized: true,
    });
  });

  it('shows the canonical safe reason below a model-request failure', () => {
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed (no retry available)', {
      message: 'HTTP 400 Bad Request – status code without a body',
      provider: 'openai',
      userRetryable: false,
      rawErrorBody: { apiKey: 'secret-must-not-render' },
    });

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'error',
      text: [
        'Model request failed (no retry available)',
        '⎿ HTTP 400 Bad Request – status code without a body',
      ].join('\n'),
      finalized: true,
    });
    expect(entries[0]?.text).not.toContain('secret-must-not-render');
    expect(transcriptEntryLayout(entries[0]!, { width: 80 }).lines).toEqual([
      '! Model request failed (no retry available)',
      '  ⎿ HTTP 400 Bad Request – status code without a body',
    ]);
  });

  it('keeps the error summary when structured error data is malformed', () => {
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed', {
      message: { nested: 'not a canonical message' },
      rawErrorBody: { apiKey: 'secret-must-not-render' },
      userRetryable: 'sometimes',
    });

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries[0]?.text).toBe('Model request failed');
  });

  it('removes terminal control sequences from model-error reasons', () => {
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed', {
      message: '\u001b[31mProvider failed\u001b[0m\u0007 \n retry later\u0085',
      userRetryable: false,
    });

    syncStreamLog(root);

    const text = streamEntries(root)[0]?.text ?? '';
    expect(text).toBe('Model request failed\n⎿ Provider failed retry later');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).not.toContain('\u0085');
  });

  it('redacts credentials embedded in the canonical provider message', () => {
    const logger = runTrace(root);
    const secret = 'sk-provider-redaction-example-1234567890abcdef';
    const ansiSplitSecret = `${secret.slice(0, 12)}\u001b[31m${secret.slice(12)}\u001b[0m`;
    logModelError(
      logger,
      `Model request failed with Bearer ${ansiSplitSecret}`,
      {
        message: `Connection failed with API_KEY=${ansiSplitSecret} and Bearer ${ansiSplitSecret}`,
        userRetryable: false,
      },
    );

    syncStreamLog(root);

    const text = streamEntries(root)[0]?.text ?? '';
    expect(text).toContain('Model request failed with Bearer [redacted]');
    expect(text).toContain('API_KEY=[redacted]');
    expect(text).toContain('Bearer [redacted]');
    expect(text).not.toContain(secret);
  });

  it('collapses and bounds long multiline model-error reasons', () => {
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed', {
      message: `First line\n  second line\t${'x'.repeat(300)}`,
      userRetryable: false,
    });

    syncStreamLog(root);

    const entries = streamEntries(root);
    const lines = entries[0]?.text.split('\n') ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^⎿ First line second line x+…$/);
    expect([...lines[1]!.slice('⎿ '.length)]).toHaveLength(240);
  });

  it('adds the personal-API hint once from structured relay-limit data', () => {
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed', {
      message: `${'x'.repeat(300)} Monthly spending limit reached.`,
      exhaustionReason: 'relay-limit',
      userRetryable: false,
    });

    syncStreamLog(root);
    syncStreamLog(root);

    const text = streamEntries(root)[0]?.text ?? '';
    expect(text).toContain('\n⎿ ');
    expect(text).not.toContain('Monthly spending limit reached.');
    expect(text.match(/\/api personal/g)).toHaveLength(1);
  });

  it('keeps actual tool failures on the tool-row renderer', () => {
    const logger = runTrace(root);
    logger.error('Actual tool failed', {
      messageType: MESSAGE_TYPES.TOOL_USE,
      data: {
        toolName: 'bash',
        input: { command: 'false' },
        error: 'The shell command exited with status 1.',
        status: 'failed',
        message: 'must not become a model-error continuation',
      },
    });

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'tool',
      text: '',
      toolUse: {
        toolName: 'bash',
        errorText: 'The shell command exited with status 1.',
        isError: true,
        status: 'failed',
      },
    });
  });

  it('tracks hidden thinking activity without rendering thinking text', () => {
    const logger = runTrace(root);
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

  it('projects workflow tools and errors while excluding thinking and raw model prose', () => {
    markWorkflow(root);
    const logger = runTrace(root);
    const thinking = logger.openStream(MESSAGE_TYPES.THINKING);
    thinking.append('private workflow reasoning');
    logModelResponse(logger, 'raw workflow model response');
    logToolUse(logger, {
      toolName: 'bash',
      input: { command: 'true' },
      output: 'done',
      status: 'completed',
    });
    logModelError(logger, 'workflow provider failed');
    patchStream(root, (slice) => ({
      ...slice,
      entries: [
        localSyntheticEntry(
          'synthetic-workflow-user',
          'user',
          'synthetic workflow prompt',
          4,
          3,
        ),
        localSyntheticEntry(
          'synthetic-workflow-assistant',
          'assistant',
          'synthetic workflow response',
          4,
          3,
        ),
        localSyntheticEntry(
          'synthetic-workflow-error',
          'error',
          'synthetic workflow error',
          4,
          3,
        ),
      ],
    }));

    syncStreamLog(root);

    const slice = streams.get().get(root);
    expect(slice?.entries.map(({ role }) => role)).toEqual([
      'tool',
      'error',
      'error',
    ]);
    expect(JSON.stringify(slice)).toContain('workflow provider failed');
    expect(JSON.stringify(slice)).toContain('synthetic workflow error');
    expect(JSON.stringify(slice)).not.toContain('private workflow reasoning');
    expect(JSON.stringify(slice)).not.toContain('raw workflow model response');
    expect(JSON.stringify(slice)).not.toContain('synthetic workflow prompt');
    expect(JSON.stringify(slice)).not.toContain('synthetic workflow response');
    expect(slice?.latestLine).toBe('synthetic workflow error');
  });

  it('admits ordinary workflow logs without exposing unsafe terminal text', () => {
    markWorkflow(child1);
    const logger = runTrace(child1);
    const secret = 'sk-workflow-summary-1234567890abcdef';
    const ansiSplitSecret = `${secret.slice(0, 12)}\u001b[31m${secret.slice(12)}\u001b[0m`;
    logUserMessage(logger, 'workflow prompt');
    logger.info(
      `Preparing \u001b[32mproof\u001b[0m audit\u0007 API_KEY=${ansiSplitSecret}`,
      { messageType: MESSAGE_TYPES.DEFAULT },
    );
    logModelResponse(logger, 'raw workflow model response');

    syncStreamLog(child1);

    let slice = streams.get().get(child1);
    expect(slice?.latestLine).toBe('Preparing proof audit API_KEY=[redacted]');
    expect(slice?.latestLine).not.toContain(secret);
    expect(slice?.latestLine).not.toContain('\u001b');
    expect(slice?.latestLine).not.toContain('\u0007');
    expect(slice?.entries).toMatchObject([
      {
        role: 'assistant',
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'Preparing proof audit API_KEY=[redacted]',
      },
    ]);
    expect(JSON.stringify(slice?.entries)).not.toContain(
      'raw workflow model response',
    );

    logToolUse(logger, {
      toolName: 'bash',
      input: { command: 'true' },
      output: 'done',
      summary: `Checking with Bearer ${ansiSplitSecret}\u0085`,
      status: 'completed',
    });
    syncStreamLog(child1);
    const toolDescription = streams.get().get(child1)?.latestLine;
    expect(toolDescription).toBe('Checking with Bearer [redacted]');
    expect(toolDescription).not.toContain(secret);
    expect(toolDescription).not.toContain('\u001b');
    expect(toolDescription).not.toContain('\u0085');

    logToolUse(logger, {
      toolName: 'read_file',
      input: { path: 'proof.tex' },
      output: 'done',
      summary: '\u001b[31m\u001b[0m\u0007',
      status: 'completed',
    });
    syncStreamLog(child1);
    expect(streams.get().get(child1)?.latestLine).toBe('read_file');

    logger.openStage('Review lemmas', {
      id: 'review-phase',
      kind: 'phase',
      index: 1,
      total: 2,
    });
    syncStreamLog(child1);
    expect(streams.get().get(child1)?.latestLine).toBe('Review lemmas');

    logModelError(logger, 'Proof audit failed');
    syncStreamLog(child1);

    slice = streams.get().get(child1);
    expect(slice?.latestLine).toBe('Proof audit failed');
    expect(slice?.entries.map(({ role }) => role)).toEqual([
      'assistant',
      'tool',
      'tool',
      'phase',
      'error',
    ]);
    expect(JSON.stringify(slice)).not.toContain('workflow prompt');
    expect(JSON.stringify(slice)).toContain(
      'Preparing proof audit API_KEY=[redacted]',
    );
    expect(JSON.stringify(slice)).not.toContain(secret);
    expect(JSON.stringify(slice)).not.toContain('raw workflow model response');
  });

  it('updates dormant workflow summaries while retaining only dashboard rows', () => {
    activeStreamId.set(root);
    markWorkflow(child1);
    const logger = runTrace(child1);
    logModelResponse(logger, 'raw dormant workflow prose');
    logger.info('Preparing dormant audit', {
      messageType: MESSAGE_TYPES.DEFAULT,
    });

    syncStreamLog(child1);

    expect(streams.get().get(child1)).toMatchObject({
      latestLine: 'Preparing dormant audit',
      entries: [],
    });

    logToolUse(logger, {
      toolName: 'grep',
      input: { pattern: 'lemma' },
      output: 'done',
      summary: 'Scanning proof obligations',
      status: 'completed',
    });
    syncStreamLog(child1);

    expect(streams.get().get(child1)).toMatchObject({
      latestLine: 'Scanning proof obligations',
      entries: [],
    });

    logger.openStage('Checking dormant lemmas', {
      id: 'dormant-review-phase',
      kind: 'phase',
    });
    syncStreamLog(child1);

    expect(streams.get().get(child1)).toMatchObject({
      latestLine: 'Checking dormant lemmas',
      entries: [
        {
          id: 'dormant-review-phase',
          role: 'phase',
          phaseLabel: 'Checking dormant lemmas',
        },
      ],
    });

    logModelError(logger, 'Dormant audit failed');
    syncStreamLog(child1);

    const slice = streams.get().get(child1);
    expect(slice).toMatchObject({
      latestLine: 'Dormant audit failed',
      entries: [
        {
          id: 'dormant-review-phase',
          role: 'phase',
        },
      ],
    });
    expect(JSON.stringify(slice)).not.toContain('raw dormant workflow prose');
  });

  it('bounds dormant workflow dashboard rows while preserving source order', () => {
    activeStreamId.set(root);
    patchStream(child1, (slice) => ({
      ...slice,
      category: AgentCategory.Workflow,
      entries: [
        localSyntheticEntry(
          'synthetic-compact-workflow-error',
          'error',
          'Synthetic compact workflow error',
          0,
          0,
        ),
      ],
    }));
    const logger = runTrace(child1);
    logger.openStage('Old phase', {
      id: 'compact-old-phase',
      kind: 'phase',
    });
    for (let index = 0; index < 2_002; index += 1) {
      logger.info(`Task ${index}`, {
        messageType: MESSAGE_TYPES.WORKFLOW_TASK,
        data: {
          id: `task-${index}`,
          label: `Task ${index}`,
          phase: 'Old phase',
          status: 'cached',
        },
      });
      if (index === 1_000) {
        logger.info('Compact operational prose', {
          messageType: MESSAGE_TYPES.DEFAULT,
        });
        logToolUse(
          logger,
          {
            toolName: 'grep',
            input: { pattern: 'boundary' },
            output: 'done',
            summary: 'Compact operational tool summary',
            status: 'completed',
          },
          'Compact tool activity',
        );
        logModelError(logger, 'Compact operational failure');
      }
    }
    logger.openStage('New phase', {
      id: 'compact-new-phase',
      kind: 'phase',
    });

    syncStreamLog(child1);

    const entries = streamEntries(child1);
    const dashboardEntries = entries.filter((entry) => !entry.synthetic);
    expect(dashboardEntries).toHaveLength(2_000);
    expect(dashboardEntries[0]).toMatchObject({
      role: 'workflowTask',
      task: { id: 'task-3' },
    });
    expect(dashboardEntries.at(-2)).toMatchObject({
      role: 'workflowTask',
      task: { id: 'task-2001' },
    });
    expect(dashboardEntries.at(-1)).toMatchObject({
      id: 'compact-new-phase',
      role: 'phase',
      phaseLabel: 'New phase',
    });
    expect(
      dashboardEntries
        .filter((entry) => entry.role === 'workflowTask')
        .map((entry) => entry.task.id),
    ).toEqual(Array.from({ length: 1_999 }, (_, index) => `task-${index + 3}`));
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: 'synthetic-compact-workflow-error',
        synthetic: true,
      }),
    );
    expect(JSON.stringify(entries)).not.toContain('Compact operational');
    expect(JSON.stringify(entries)).not.toContain('compact-old-phase');
  });

  it('keeps the runtime description while the latest line follows the transcript', () => {
    withRunFacts((hub) => {
      activeStreamId.set(root);
      hub.emit({
        scope: 'session',
        event: {
          type: 'updateStreamDescription',
          payload: {
            streamId: child1,
            description: 'Audit the compactness lemma.',
          },
        },
      });
      const logger = runTrace(child1);
      logUserMessage(logger, 'Check the second lemma.');
      logModelResponse(logger, 'The second lemma is valid.');

      syncStreamLog(child1);

      expect(streams.get().get(child1)).toMatchObject({
        description: 'Audit the compactness lemma.',
        latestLine: 'The second lemma is valid.',
      });
    });
  });

  it('updates one semantic context-compaction transcript entry in place', () => {
    const logger = runTrace(root);
    const activity = startCompactionActivity(logger);

    syncStreamLog(root);

    let slice = streams.get().get(root);
    expect(slice?.compactingActive).toBe(true);
    expect(slice?.entries).toHaveLength(1);
    expect(slice?.entries[0]).toMatchObject({
      id: `compaction:${activity.operationId}`,
      role: 'activity',
      text: 'Compacting context…',
      finalized: false,
      activity: { status: 'running' },
    });

    activity.finish('completed');
    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.compactingActive).toBe(false);
    expect(slice?.entries).toHaveLength(1);
    expect(slice?.entries[0]).toMatchObject({
      id: `compaction:${activity.operationId}`,
      role: 'activity',
      text: 'Context compacted',
      finalized: true,
      activity: { status: 'completed' },
    });
  });

  it('moves compaction to Static while its response text keeps streaming', () => {
    const logger = runTrace(root);
    const activity = startCompactionActivity(logger);
    const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Visible answer');

    syncStreamLog(root);

    let entries = streamEntries(root);
    expect(entries).toMatchObject([
      {
        id: `compaction:${activity.operationId}`,
        role: 'activity',
        finalized: false,
        activity: { status: 'running' },
      },
      { role: 'assistant', text: 'Visible answer', finalized: false },
    ]);

    activity.finish('completed');
    syncStreamLog(root);

    entries = streamEntries(root);
    expect(entries).toMatchObject([
      {
        id: `compaction:${activity.operationId}`,
        role: 'activity',
        finalized: true,
        activity: { status: 'completed' },
      },
      { role: 'assistant', text: 'Visible answer', finalized: false },
    ]);
    const split = splitTranscriptEntries(entries, STREAM_PHASE.RUNNING);
    expect(split.finalized.map((entry) => entry.id)).toEqual([
      `compaction:${activity.operationId}`,
    ]);
    expect(split.pending.map((entry) => entry.role)).toEqual(['assistant']);

    output.finalize();
  });

  it('clears an unmatched compaction start when later live activity arrives', () => {
    const logger = runTrace(root);

    const activity = startCompactionActivity(logger);
    syncStreamLog(root);
    expect(streams.get().get(root)?.compactingActive).toBe(true);

    logUserMessage(logger, 'A later turn started.');
    syncStreamLog(root);

    const slice = streams.get().get(root);
    expect(slice?.compactingActive).toBe(false);
    expect(slice?.entries).toContainEqual(
      expect.objectContaining({
        id: `compaction:${activity.operationId}`,
        role: 'activity',
        finalized: true,
        activity: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
  });

  it('does not project empty assistant responses into transcript rows', () => {
    const logger = runTrace(root);
    logModelResponse(logger, '');

    syncStreamLog(root);

    let slice = streams.get().get(root);
    expect(slice?.entries ?? []).toEqual([]);

    logModelResponse(logger, 'Visible answer.');

    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.entries.map((entry) => entry.text)).toEqual([
      'Visible answer.',
    ]);
  });

  it('trims leading blank assistant rows at turn start', () => {
    const logger = runTrace(root);
    logUserMessage(logger, 'Why?');
    logModelResponse(logger, '\n\n  The answer starts here.');

    syncStreamLog(root);

    expect(entryTexts(root)).toEqual(['Why?', '  The answer starts here.']);
  });

  // Regression: a sync tick that fires after `finalizeAssistantTranscriptEntries`
  // must not roll the entry back to `finalized: false`. Without this guard,
  // the de-finalized entry lands in neither bucket of
  // `splitTranscriptEntries` once status flips to WAITING, and silently
  // disappears from the transcript.
  it('preserves the finalized flag through a post-finalize sync tick', () => {
    const logger = runTrace(root);
    logModelResponse(logger, 'streaming assistant chunk');
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

    const entries = streamEntries(root);
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
    const logger = runTrace(root);
    const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    // Raw provider text, as it would arrive before replacement rules run.
    output.append('Done ✓');
    output.finalize();
    // The flow boundary's authoritative (replacement-cleaned) text.
    logger.responseFinalized('Done \\checkmark');

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'Done \\checkmark',
    });
    expect(entries[0]?.synthetic).toBeUndefined();
  });

  it('appends the final response when the round produced no live stream', () => {
    const logger = runTrace(root);
    logger.responseFinalized('The answer is 2.');

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      text: 'The answer is 2.',
    });
    expect(entries[0]?.synthetic).toBeUndefined();
  });

  it('keeps only a summary for an unfocused dormant transcript', () => {
    activeStreamId.set(root);
    const logger = runTrace(child1);
    logUserMessage(logger, 'Check the second lemma.');
    logModelResponse(logger, 'The second lemma is valid.');
    setStatus(child1, STREAM_PHASE.WAITING);

    syncStreamLog(child1);

    expect(streams.get().get(child1)).toMatchObject({
      latestLine: 'The second lemma is valid.',
      entries: [],
      status: STREAM_PHASE.WAITING,
    });
  });

  it('restores an exact dormant transcript when it is requested', () => {
    activeStreamId.set(root);
    const logger = runTrace(child1);
    logUserMessage(logger, 'Check the second lemma.');
    logModelResponse(logger, 'The second lemma is valid.');
    setStatus(child1, STREAM_PHASE.WAITING);
    syncStreamLog(child1);

    syncStreamLog(child1, { forceFull: true });

    expect(
      streamEntries(child1).map((entry) => [entry.role, entry.text]),
    ).toEqual([
      ['user', 'Check the second lemma.'],
      ['assistant', 'The second lemma is valid.'],
    ]);
  });

  it('does not let an earlier round leak its stream id into a later round', () => {
    const logger = runTrace(root);
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

    const entries = streamEntries(root);
    expect(entries.map((entry) => entry.text)).toEqual([
      'Let me check that.',
      'Final answer.',
    ]);
    expect(entries.every((entry) => !entry.synthetic)).toBe(true);
  });

  it('projects a turn boundary from the store alone, with zero synthetic entries', () => {
    const logger = runTrace(root);
    logUserMessage(logger, 'What is 1 + 1?');
    logModelResponse(logger, '2');

    projectStreamTranscript(root, { finalize: true });

    const entries = streamEntries(root);
    expect(entries.map((entry) => entry.text)).toEqual(['What is 1 + 1?', '2']);
    expect(entries.map((entry) => entry.finalized)).toEqual([true, true]);
    expect(entries.every((entry) => !entry.synthetic)).toBe(true);
  });

  it('keeps repeated local slash-command responses visible', () => {
    activeStreamId.set(root);

    appendLocalAssistantTranscript('Available commands: /help');
    appendLocalAssistantTranscript('Available commands: /help');

    expect(entryTexts(root)).toEqual([
      'Available commands: /help',
      'Available commands: /help',
    ]);
  });

  it('preserves literal checkmark commands in local user transcript text', () => {
    activeStreamId.set(root);

    appendLocalUserTranscript('literal \\checkmark');

    const entries = streamEntries(root);
    expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'literal \\checkmark'],
    ]);
  });

  it('can append local assistant output to an explicit stream', () => {
    activeStreamId.set(root);

    appendLocalAssistantTranscript('Child stream note.', child1);

    expect(streamEntries(root)).toEqual([]);
    expect(entryTexts(child1)).toEqual(['Child stream note.']);
  });

  it('keeps root local notices out of a focused child stream', () => {
    rootStreamId.set(root);
    setParentStream(child1, root);
    activeStreamId.set(child1);

    appendLocalAssistantTranscript('Available commands: /help');
    appendLocalErrorTranscript('Model claude-opus-4-7 not found');

    expect(
      streamEntries(root).map((entry) => [entry.role, entry.text]),
    ).toEqual([
      ['assistant', 'Available commands: /help'],
      ['error', 'Model claude-opus-4-7 not found'],
    ]);
    expect(streamEntries(child1)).toEqual([]);
    expect(activeStreamId.get()).toBe(child1);
  });

  it('uses the focused child parent for local notices before root id is set', () => {
    setParentStream(child1, root);
    activeStreamId.set(child1);

    appendLocalAssistantTranscript('Slash command output.');

    expect(entryTexts(root)).toEqual(['Slash command output.']);
    expect(streamEntries(child1)).toEqual([]);
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

    const entries = streamEntries(root);
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
    const logger = runTrace(root);
    const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    stream.append('A short final answer.');

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entries.map((entry) => entry.text)).toEqual([
      'A short final answer.',
    ]);
  });

  it('finalizes a delayed first model-response sync after the stream is idle', () => {
    const logger = runTrace(root);
    logModelResponse(logger, 'A delayed final answer.');
    setStatus(root, STREAM_PHASE.WAITING);

    syncStreamLog(root);

    const entries = streamEntries(root);
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
    const logger = runTrace(root);
    logUserMessage(logger, 'prompt');
    syncStreamLog(root);
    activeStreamId.set(root);

    appendLocalAssistantTranscript('Available commands: /help');
    logModelResponse(logger, 'partial response');
    syncStreamLog(root);

    appendLocalAssistantTranscript('Available commands: /help');
    syncStreamLog(root);

    const entries = streamEntries(root);
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
        localSyntheticEntry(
          'local-help',
          'assistant',
          'Available commands: /help',
          1,
          0,
        ),
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
    const entry = toolEntry('empty-tool', 'executions', {
      path: '/executions/3a780a389327/report',
    });

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
      toolEntry(
        'tool',
        'Bash',
        { command: 'ls' },
        { outputText: 'one\ntwo\nthree' },
      ),
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

    expect(streamEntries(CLI_LOCAL_STREAM_ID)).toHaveLength(1);

    moveLocalTranscriptToStream(root);

    expect(streams.get().has(CLI_LOCAL_STREAM_ID)).toBe(false);
    expect(activeStreamId.get()).toBe(root);
    expect(entryTexts(root)).toEqual(['Available commands: /help']);
  });

  it('can discard pre-resume local slash-command output', () => {
    appendLocalAssistantTranscript('/resume exec-1');

    expect(activeStreamId.get()).toBe(CLI_LOCAL_STREAM_ID);
    expect(streamEntries(CLI_LOCAL_STREAM_ID)).toHaveLength(1);

    clearLocalTranscript();

    expect(streams.get().has(CLI_LOCAL_STREAM_ID)).toBe(false);
    expect(activeStreamId.get()).toBeUndefined();
  });

  it('preserves the finalized response across later log syncs', () => {
    const logger = runTrace(root);
    logUserMessage(logger, '1+1');
    syncStreamLog(root);
    logger.responseFinalized('The answer is 2.');

    logUserMessage(logger, 'next prompt');
    syncStreamLog(root);

    expect(entryTexts(root)).toEqual([
      '1+1',
      'The answer is 2.',
      'next prompt',
    ]);
  });

  it('orders multiple finalized responses relative to the turns around them', () => {
    const logger = runTrace(root);
    logUserMessage(logger, 'first prompt');
    syncStreamLog(root);
    logger.responseFinalized('first answer');

    logUserMessage(logger, 'second prompt');
    syncStreamLog(root);
    logger.responseFinalized('second answer');

    logUserMessage(logger, 'third prompt');
    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entryTexts(root)).toEqual([
      'first prompt',
      'first answer',
      'second prompt',
      'second answer',
      'third prompt',
    ]);
    expect(entries.every((entry) => !entry.synthetic)).toBe(true);
  });
});

describe('sessionSignalsAdapter run facts', () => {
  it('clears follow-up routing when current run metadata omits capability', () => {
    withRunFacts((hub) => {
      const executionId = 'e9911-adapter' as ExecutionId;
      setStatus(child1, STREAM_PHASE.WAITING);
      setParentStream(child1, root);
      emitRunConfig(hub, child1, executionId);
      hub.emit({
        scope: 'run',
        streamId: child1,
        event: {
          type: 'run.start',
          streamId: child1,
          executionId,
          identity: { kind: 'agent', agent: 'search' },
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
        },
      });

      expect(streams.get().get(child1)?.userFollowUpSupport).toBe(
        USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      );
      focusStream(child1);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });

      hub.emit({
        scope: 'run',
        streamId: child1,
        event: {
          type: 'run.start',
          streamId: child1,
          executionId,
          identity: { kind: 'agent', agent: 'search' },
        },
      });

      expect(streams.get().get(child1)?.userFollowUpSupport).toBeUndefined();
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'reject',
        streamId: child1,
      });
    });
  });

  it('keeps a session-scoped fact subscription live after state reset', () => {
    withRunFacts((hub) => {
      const nextRoot = 'root-after-clear' as StreamTabId;
      const todos: TodoItem[] = [
        {
          content: 'Continue after clear',
          status: TODO_STATUS.PENDING,
          activeForm: 'Continuing after clear',
        },
      ];

      resetCliState();
      hub.emit({
        scope: 'run',
        streamId: nextRoot,
        event: {
          type: 'updateTodos',
          streamId: nextRoot,
          todos,
        },
      });

      expect(streams.get().get(nextRoot)?.todos).toEqual(todos);
    });
  });

  it('does not resurrect a stream retired while attachment awaited rehydrate', async () => {
    // Inline setup instead of `withRunFacts`: the applier's
    // `handleSetActiveStream` awaits `streamLogs.ensureLoaded`, so the body
    // must stay attached across a microtask flush.
    const hub = new SessionEventHub();
    const snapshots = new StreamSnapshotStore();
    const session = new SessionHandle({
      events: hub,
      snapshots,
      transcripts: StreamLogStore.ephemeral('TUI reset-race test'),
    });
    const detach = attachSessionSignalsAdapter({
      events: hub,
      session,
      snapshots,
    });
    try {
      hub.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId: root,
            agentCategory: AgentCategory.ToolUse,
          },
        },
      });
      // The synchronous half of the attachment already minted the slice; the
      // applier is now suspended in `streamLogs.ensureLoaded`.
      expect(streams.get().has(root)).toBe(true);

      // `/clear` lands during that await and retires the stream identity.
      resetCliState();
      await new Promise((resolve) => setImmediate(resolve));

      // The resumed continuation must not re-mint, un-retire, or focus it.
      expect(streams.get().has(root)).toBe(false);
      expect(activeStreamId.get()).toBeUndefined();
      focusStream(root);
      expect(activeStreamId.get()).toBeUndefined();
    } finally {
      detach();
      snapshots.evictAll();
    }
  });

  it('applies typed updateTodos run facts without host emission', () => {
    withRunFacts((hub) => {
      const todos: TodoItem[] = [
        {
          content: 'State the compactness lemma',
          status: TODO_STATUS.PENDING,
          activeForm: 'Stating the compactness lemma',
        },
      ];

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
    });
  });

  it('applies typed updatePlan run facts without host emission', () => {
    withRunFacts((hub) => {
      const plan: Plan = {
        objective:
          'Prove the local estimate and record the stopping criterion.',
      };

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
    });
  });

  it('keeps a captured work-plan reader synchronized after focus moves', () => {
    withRunFacts((hub) => {
      const nextPlan: Plan = { objective: 'Updated reader objective.' };
      const nextTodos: TodoItem[] = [
        {
          content: 'Refresh the captured reader',
          status: TODO_STATUS.IN_PROGRESS,
          activeForm: 'Refreshing the captured reader',
        },
      ];

      patchStream(root, (slice) => ({ ...slice }));
      patchStream(child1, (slice) => ({ ...slice }));
      finishWorkPlanReaderRequest(beginWorkPlanReaderRequest(root));
      activeStreamId.set(child1);
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updatePlan',
          streamId: root,
          plan: nextPlan,
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updateTodos',
          streamId: root,
          todos: nextTodos,
        },
      });

      expect(streams.get().get(root)).toMatchObject({
        plan: nextPlan,
        todos: nextTodos,
      });
      expect(foregroundReader.get()).toEqual({
        kind: 'workPlan',
        streamId: root,
      });
    });
  });

  it('applies typed goalPaused run facts without host emission', () => {
    withRunFacts((hub) => {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'goalPaused',
          streamId: root,
        },
      });

      expect(entryTexts(root)).toEqual([GOAL_PAUSED_TRANSCRIPT_NOTICE]);
    });
  });

  it('applies direct stage.start(kind: round) events without host emission', () => {
    withRunFacts((hub) => {
      emitStageStart(hub, root, {
        id: 'round-2',
        label: 'Round 2',
        kind: 'round',
        index: 1,
        total: 3,
      });

      expect(streams.get().get(root)?.stage).toEqual({
        kind: 'round',
        index: 1,
        total: 3,
      });
    });
  });

  it('applies direct non-round stage.start events to the phase slot, not the round slot', () => {
    withRunFacts((hub) => {
      emitStageStart(hub, root, {
        id: 'phase-1',
        label: 'Compile phase',
        kind: 'phase',
        index: 0,
      });

      expect(streams.get().get(root)?.stage).toEqual({
        kind: 'phase',
        label: 'Compile phase',
        index: 0,
      });
    });
  });

  it('applies direct child activity and parent-link facts without host emission', () => {
    withRunFacts((hub) => {
      const child: ActiveChildInfo = childRosterRow(
        'critic',
        child1,
        STREAM_PHASE.RUNNING,
        'agent-1',
      );

      // The child's own status is the single owner the roster selectors read
      // from (rule 8: the roster's copied status is discarded).
      setStatus(child1, STREAM_PHASE.RUNNING);
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'child.activity',
          parentStreamId: root,
          items: [child],
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

      expect(activeRows(root)).toEqual([child]);
      expect(retainedRows(root)).toEqual([child]);
      expect(parentStream.get().get(child1)).toBe(root);
      expect(parentStream.get().get(child2)).toBe(root);
    });
  });

  it('applies direct usage events without host emission', () => {
    withRunFacts((hub) => {
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

      emitUsage(hub, root, storageKey, usage, 'exec-direct');

      expect(streams.get().get(root)?.usage).toEqual(usage);
      // Cumulative usage is the snapshot store's per-run accumulator summed;
      // reasoningTokens is part of the one accumulated vocabulary.
      expect(streams.get().get(root)?.cumulativeUsage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        cost: 1,
        cacheReadInputTokens: 30,
        cacheMissInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 7,
      });
    });
  });

  it('applies direct session stream facts without host emission', () => {
    withRunFacts((hub) => {
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
    });
  });

  it('applies direct run config and conversation progress without host emission', () => {
    withRunFacts((hub) => {
      emitRunConfig(hub, root, 'exec-config', {
        input: ['src/Main.lean'],
        context: ['notes/proof.md'],
        output: ['build/Main.olean'],
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
        agent: 'search',
        model: 'kimi26T',
        category: AgentCategory.ToolUse,
        files: {
          input: ['src/Main.lean'],
          context: ['notes/proof.md'],
          media: [],
          output: ['build/Main.olean'],
        },
        conversation: { toolCallCount: 3 },
      });
    });
  });

  it('streams every workflow output round into selected-agent state', () => {
    withRunFacts((hub) => {
      // A real hex id: the snapshot store (now the accumulator the slice is
      // projected from) parses output-file payloads, and ExecutionIdSchema
      // rejects non-hex ids the old slice-spread silently accepted.
      const executionId = 'ab12cd34ef56' as ExecutionId;

      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'addOutputFiles',
          streamId: root,
          executionId,
          filesByRound: {
            0: [
              {
                source: 'draft.tex',
                location: {
                  kind: 'runStorage',
                  executionId,
                  relativePath: 'r1/draft.tex',
                  absolutePath:
                    '/tmp/texra/executions/ab12cd34ef56/r1/draft.tex',
                },
                round: 0,
                lineage: null,
                diff: null,
              },
            ],
          },
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'addOutputFiles',
          streamId: root,
          executionId,
          filesByRound: {
            1: [
              {
                source: 'paper.tex',
                location: {
                  kind: 'runStorage',
                  executionId,
                  relativePath: 'r2/paper.tex',
                  absolutePath:
                    '/tmp/texra/executions/ab12cd34ef56/r2/paper.tex',
                },
                round: 1,
                lineage: null,
                diff: null,
              },
            ],
          },
        },
      });

      expect(streams.get().get(root)?.outputFilesByRound).toEqual({
        0: [
          expect.objectContaining({
            location: expect.objectContaining({
              absolutePath: '/tmp/texra/executions/ab12cd34ef56/r1/draft.tex',
            }),
          }),
        ],
        1: [
          expect.objectContaining({
            location: expect.objectContaining({
              absolutePath: '/tmp/texra/executions/ab12cd34ef56/r2/paper.tex',
            }),
          }),
        ],
      });
    });
  });

  it('projects missing-output and compile facts and clears the addressed stream', () => {
    withRunFacts((hub) => {
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updateMissingOutputs',
          streamId: root,
          filesByRound: { 0: ['missing.tex'] },
        },
      });
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updateCompileFailures',
          streamId: root,
          filesByRound: {
            0: [
              {
                round: 0,
                displayName: 'paper.pdf',
                output: {
                  kind: 'external',
                  absolutePath: '/tmp/paper.pdf',
                },
                log: {
                  kind: 'external',
                  absolutePath: '/tmp/paper.log',
                },
                logRelativePath: 'paper.log',
              },
            ],
          },
        },
      });

      expect(streams.get().get(root)).toMatchObject({
        missingOutputsByRound: { 0: ['missing.tex'] },
        compileFailuresByRound: {
          0: [expect.objectContaining({ displayName: 'paper.pdf' })],
        },
      });

      hub.emit({
        scope: 'session',
        event: {
          type: 'clearMissingOutputs',
          payload: { streamId: root },
        },
      });
      expect(streams.get().get(root)?.missingOutputsByRound).toEqual({});

      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'updateMissingOutputs',
          streamId: root,
          filesByRound: { 1: ['again.tex'] },
        },
      });
      hub.emit({
        scope: 'session',
        event: {
          type: 'clearMissingOutputs',
          payload: { streamId: root },
        },
      });

      expect(streams.get().get(root)?.missingOutputsByRound).toEqual({});
      expect(streams.get().get(root)?.compileFailuresByRound[0]).toHaveLength(
        1,
      );
    });
  });

  it('applies direct usage sequences exactly once', () => {
    withRunFacts((hub) => {
      const storageKey = 'root-direct-sequence-run' as StorageKey;
      const firstUsage = {
        inputTokens: 100,
        outputTokens: 20,
        cost: 1,
        cacheReadInputTokens: 30,
        elapsedTime: 1.5,
        percentageCached: 25,
        reasoningTokens: 7,
      };
      const secondUsage = {
        inputTokens: 50,
        outputTokens: 10,
        cost: 0.5,
        cacheReadInputTokens: 5,
        elapsedTime: 0.8,
        percentageCached: 10,
        reasoningTokens: 3,
      };

      emitUsage(hub, root, storageKey, firstUsage, 'exec-direct-sequence');
      emitUsage(hub, root, storageKey, secondUsage, 'exec-direct-sequence');

      expect(streams.get().get(root)?.usage).toEqual(secondUsage);
      // Summed from the store's per-run map — the one accumulator, which
      // carries reasoningTokens — not a second running sum in the slice.
      expect(streams.get().get(root)?.cumulativeUsage).toEqual({
        inputTokens: 150,
        outputTokens: 30,
        cost: 1.5,
        cacheReadInputTokens: 35,
        cacheMissInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 10,
      });
    });
  });

  it('registers suppressed child streams without switching away from the parent page', () => {
    withRunFacts((hub) => {
      activeStreamId.set(root);

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
    });
  });

  it('captures per-stream model identity from task state', () => {
    withRunFacts((hub) => {
      emitRunConfig(hub, child1, 'exec-search');

      expect(streams.get().get(child1)).toMatchObject({
        model: 'kimi26T',
        category: AgentCategory.ToolUse,
      });
    });
  });

  it('refreshes queued follow-up display when an active follow-up is sent', () => {
    setStatus(root, STREAM_PHASE.RUNNING);
    withRunFacts((hub, session) => {
      const lease = session.followUps.claimLive(root, 'flow')!;
      const queue = session.followUps.queue(lease);
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
        expect(slice?.queuedFollowUpMessages).toEqual([]);
      } finally {
        session.followUps.terminalize(root);
      }
    });
  });

  it('keeps latest usage separate from cumulative resume usage', () => {
    withRunFacts((hub) => {
      const storageKey = 'root-run' as StorageKey;

      emitUsage(hub, root, storageKey, {
        inputTokens: 100,
        outputTokens: 20,
        cost: 1,
        cacheReadInputTokens: 30,
      });
      emitUsage(hub, root, storageKey, {
        inputTokens: 40,
        outputTokens: 10,
        cost: 2,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 7,
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
        reasoningTokens: 0,
      });
    });
  });
});

describe('session tree order', () => {
  it('orders retained sibling sessions', () => {
    projectChildRoster(root, [
      childRosterRow('a', child1, undefined, 'e1'),
      childRosterRow('b', child2, undefined, 'e2'),
    ]);
    setParentStream(child1, root);
    setParentStream(child2, root);
    setStatus(child1, STREAM_PHASE.RUNNING);
    setStatus(child2, STREAM_PHASE.RUNNING);
    expect(orderedSessionDescendants(root)).toEqual([child1, child2]);
  });

  it('retains an inactive child session with history', () => {
    setParentStream(child1, root);
    setStatus(root, STREAM_PHASE.WAITING);
    setStatus(child1, STREAM_PHASE.WAITING);

    expect(orderedSessionDescendants(root)).toEqual([child1]);
  });
});

// Ordered event-transition matrix for the child-stream relationship map
// (docs/proposals/2026-07-10-cli-child-stream-state-consolidation.md, "Race-regression
// plan" / "Ordered unit matrix"). Each scenario drives the real transition
// functions the production event handlers call
// (sessionSignalsAdapter.applyActiveSubagents -> projectChildRoster,
// sessionSignalsAdapter.applyParentStream -> setParentStream, cliState's
// removeStream -> applyChildStreamRemoval) in the stated order and asserts
// the load-bearing checkpoint(s) each sequence exists to prove, per the
// design's precedence rule:
//   removeStream tombstone > explicit edge > roster-derived parent > none.
describe('child-stream ordered transition matrix', () => {
  const parentP = 'parent-p' as StreamTabId;
  const parentQ = 'parent-q' as StreamTabId;
  const kid = 'kid' as StreamTabId;

  // Shared reference: `summaryUnchanged` compares `identity` by reference,
  // so a per-call identity object would defeat the roster no-op detection
  // that case 12 asserts.
  const kidIdentity = { kind: 'agent' as const, agent: 'kid-agent' };

  function rosterRow(status?: StreamPhase, elapsed?: string) {
    return {
      executionId: 'kid-exec',
      agentName: 'kid-agent',
      identity: kidIdentity,
      childStreamId: kid,
      status,
      elapsed,
    };
  }

  it('1. canonical order: A, S(running), R_P+, E_P+', () => {
    // A: the child's slice exists with no status of its own yet.
    mintSlice(kid);
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow()]);
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
    projectChildRoster(parentP, [rosterRow()]);
    // A: the child's slice exists with no status of its own yet.
    mintSlice(kid);
    setStatus(kid, STREAM_PHASE.RUNNING);
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
    // A: the child's slice exists with no status of its own yet.
    mintSlice(kid);
    expect(parentStream.get().get(kid)).toBe(parentP);

    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow()]);

    expect(activeRows(parentP)).toHaveLength(1);
    expect(retainedRows(parentP)).toHaveLength(1);
  });

  it('4. status first: S(running), A, E_P+, R_P+', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    setParentStream(kid, parentP);
    projectChildRoster(parentP, [rosterRow()]);

    expect(parentStream.get().get(kid)).toBe(parentP);
    expect(activeRows(parentP)).toMatchObject([
      { status: STREAM_PHASE.RUNNING },
    ]);
  });

  it('5. completion: A, S(running), R_P+, E_P+, R_P-, S(terminal)', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);

    // Untrack (roster omission) arrives before the terminal status.
    projectChildRoster(parentP, []);
    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toHaveLength(1);

    setStatus(kid, STREAM_PHASE.COMPLETED);

    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toMatchObject([
      { status: STREAM_PHASE.COMPLETED },
    ]);
  });

  it('5b. a live roster tick with only elapsed changed still updates the retained summary', () => {
    // AgentRunLifecycle untracks a finishing child (so it drops out of the
    // next roster) *before* transitioning its stream to a terminal phase, so
    // production never sends a roster tick that carries both a terminal
    // status and a fresh elapsed for this child - the last roster snapshot
    // it ever appears in is always `running`. An elapsed-only delta must
    // therefore still count as a change while the child is running, or the
    // cached summary freezes at whichever tick happened to settle first
    // (typically the very first one) instead of the last live value before
    // removal - the value the retained row and `formatPostCompactionContext`
    // read verbatim once the child is gone from the roster.
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING, '0s')]);
    setParentStream(kid, parentP);

    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING, '5s')]);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING, '41s')]);

    // The child is untracked (dropped from the roster) with its last-known
    // elapsed already captured; the terminal status lands separately.
    projectChildRoster(parentP, []);
    setStatus(kid, STREAM_PHASE.COMPLETED);

    expect(retainedRows(parentP)).toMatchObject([{ elapsed: '41s' }]);
  });

  it('6. promotion with stale roster: A, S(running), R_P+, E_P+, E0, R_P+', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    setParentStream(kid, parentP);

    setParentStream(kid, null);
    expect(parentStream.get().has(kid)).toBe(false);

    // A stale roster from the former parent must not resurrect the edge or
    // active membership.
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    expect(parentStream.get().has(kid)).toBe(false);
    expect(activeRows(parentP)).toEqual([]);
    // The historical row remains reachable from the former parent.
    expect(retainedRows(parentP)).toMatchObject([{ executionId: 'kid-exec' }]);
  });

  it('7. explicit reattachment: (6) then E_Q+, R_Q+, R_P+', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    setParentStream(kid, parentP);
    setParentStream(kid, null);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    setParentStream(kid, parentQ);
    projectChildRoster(parentQ, [rosterRow(STREAM_PHASE.RUNNING)]);
    // Late roster from the old parent must not erase active membership or
    // metadata under the new parent.
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    expect(parentStream.get().get(kid)).toBe(parentQ);
    expect(activeRows(parentQ)).toMatchObject([{ executionId: 'kid-exec' }]);
    expect(activeRows(parentP)).toEqual([]);
    // The historical row from the first parent survives (invariant 5/6).
    expect(retainedRows(parentP)).toMatchObject([{ executionId: 'kid-exec' }]);
  });

  it('8. child removal with late facts: (5) then X(child), R_P+, E_P+, A, S(terminal)', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    projectChildRoster(parentP, []);
    setStatus(kid, STREAM_PHASE.COMPLETED);

    removeStream(kid);
    expect(isChildStreamRemoved(kid)).toBe(true);

    // Every later fact for the removed id must remain suppressed — status
    // facts go through `setStreamStatusInCliState` (the actual production
    // fact-application path), which checks the tombstone directly; a raw
    // `patchStream` call (used elsewhere in this file as a low-level test
    // shortcut) intentionally has no such guard.
    projectChildRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    setStatus(kid, STREAM_PHASE.RUNNING);

    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toEqual([]);
    expect(parentStream.get().has(kid)).toBe(false);
    expect(streams.get().has(kid)).toBe(false);
  });

  it('9. fresh activation after removal uses a distinct id, not the removed one', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    removeStream(kid);

    const freshKid = 'kid-2' as StreamTabId;
    setStatus(freshKid, STREAM_PHASE.RUNNING);
    setParentStream(freshKid, parentP);
    projectChildRoster(parentP, [
      childRosterRow('kid-agent', freshKid, STREAM_PHASE.RUNNING, 'kid-2-exec'),
    ]);

    expect(isChildStreamRemoved(kid)).toBe(true);
    expect(activeRows(parentP)).toMatchObject([{ childStreamId: freshKid }]);
    expect(parentStream.get().get(freshKid)).toBe(parentP);
  });

  it('10. two-child retention keeps stable order across reordering and shrinking rosters', () => {
    const kidA = 'kid-a' as StreamTabId;
    const kidB = 'kid-b' as StreamTabId;
    const rowA = (status?: StreamPhase) =>
      childRosterRow('a', kidA, status, 'exec-a');
    const rowB = (status?: StreamPhase) =>
      childRosterRow('b', kidB, status, 'exec-b');
    setStatus(kidA, STREAM_PHASE.RUNNING);
    setStatus(kidB, STREAM_PHASE.RUNNING);

    // First-seen order: A then B.
    projectChildRoster(parentP, [rowA(), rowB()]);
    expect(retainedRows(parentP).map((r) => r.childStreamId)).toEqual([
      kidA,
      kidB,
    ]);

    // A later roster reorders (B, A) — retained order must not change.
    projectChildRoster(parentP, [rowB(), rowA()]);
    expect(retainedRows(parentP).map((r) => r.childStreamId)).toEqual([
      kidA,
      kidB,
    ]);

    // Shrink to just B; A completes.
    projectChildRoster(parentP, [rowB()]);
    setStatus(kidA, STREAM_PHASE.COMPLETED);

    expect(activeRows(parentP).map((r) => r.childStreamId)).toEqual([kidB]);
    // Retained order is still stable and A's historical row survives.
    expect(retainedRows(parentP).map((r) => r.childStreamId)).toEqual([
      kidA,
      kidB,
    ]);
    expect(visibleRows(parentP).map((r) => r.status)).toEqual([
      STREAM_PHASE.COMPLETED,
      STREAM_PHASE.RUNNING,
    ]);
  });

  it('11. parent removal with late facts: P -> child, X(P), R_P+, E_P+', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);
    setStatus(parentP, STREAM_PHASE.RUNNING);

    removeStream(parentP);
    expect(isChildStreamRemoved(parentP)).toBe(true);

    // Late facts naming the removed parent must not resurrect it as an
    // ancestor anywhere.
    projectChildRoster(parentP, [rosterRow()]);
    setParentStream(kid, parentP);

    expect(parentStream.get().get(kid)).toBeUndefined();
    expect(activeRows(parentP)).toEqual([]);
    expect(retainedRows(parentP)).toEqual([]);
  });

  it('12. identical roster snapshot applied twice is a no-op (no store write)', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    const entriesAfterFirst = childStreamEntries.get();

    // The runtime resends a fresh array/row object on every poll even when
    // nothing changed; `rosterRow` below is a distinct object with identical
    // field values, not `===` to the first call's row.
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    expect(childStreamEntries.get()).toBe(entriesAfterFirst);
  });

  it('13. first roster parent rejects a conflicting roster until an explicit edge arrives', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    projectChildRoster(parentQ, [
      { ...rosterRow(STREAM_PHASE.RUNNING), agentName: 'stale-parent' },
    ]);

    expect(parentStream.get().get(kid)).toBe(parentP);
    expect(activeRows(parentP)).toMatchObject([{ agentName: 'kid-agent' }]);
    expect(activeRows(parentQ)).toEqual([]);
  });

  it('14. tombstones stay bounded: oldest removals are evicted, live entries kept', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);

    for (let index = 0; index < 250; index += 1) {
      removeStream(`gone-${index}` as StreamTabId);
    }

    const entries = childStreamEntries.get();
    const tombstones = [...entries.values()].filter(
      (entry) => entry.kind === 'removed',
    );
    expect(tombstones).toHaveLength(200);
    expect(isChildStreamRemoved('gone-0' as StreamTabId)).toBe(false);
    expect(isChildStreamRemoved('gone-49' as StreamTabId)).toBe(false);
    expect(isChildStreamRemoved('gone-50' as StreamTabId)).toBe(true);
    expect(isChildStreamRemoved('gone-249' as StreamTabId)).toBe(true);
    // Eviction never touches live relationship state.
    expect(activeRows(parentP)).toMatchObject([{ childStreamId: kid }]);
  });

  it('15. a removed parent survives eviction while an orphaned child is still live', () => {
    setStatus(kid, STREAM_PHASE.RUNNING);
    projectChildRoster(parentP, [rosterRow(STREAM_PHASE.RUNNING)]);
    setParentStream(kid, parentP);

    removeStream(parentP);
    for (let index = 0; index < 250; index += 1) {
      removeStream(`gone-${index}` as StreamTabId);
    }

    // The child that lost this parent is still live, so the parent tombstone
    // is pinned and a late edge fact cannot re-attach the removed ancestor.
    expect(isChildStreamRemoved(parentP)).toBe(true);
    setParentStream(kid, parentP);
    expect(parentStream.get().has(kid)).toBe(false);
  });
});
