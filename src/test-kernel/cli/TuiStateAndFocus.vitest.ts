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
  bindChildStreamState,
  childRosters,
  focusOrderDescendants,
  invalidateChildStreams,
  isChildStreamRemoved,
  parentStream,
  queuedFollowUpsFor,
  retainedChildStreamsFor,
  sessionStateRevision,
  streamMetadataFor,
  streamStateFor,
  subagentExecutionLabels,
  unbindChildStreamState,
  visibleSubagentRows,
} from '@cli/chat/tui/state/childExecutions';
import {
  finalizeSettledPrefix,
  syncStreamLog,
} from '@cli/chat/tui/state/subscribeStreamLog';
import { transcriptViewportKey } from '@cli/chat/tui/state/transcriptViewportMode';
import { attachSessionSignalsAdapter } from '@cli/chat/tui/state/sessionSignalsAdapter';
import {
  markArtifactStreamHydrated,
  readStreamArtifacts,
  streamArtifactRevision,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
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
import { chatTuiFocusedChildFollowUpRoute } from '@cli/chat/tui/chatSubmitDriver';
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
import { projectStreamArtifacts } from '@controllers/session/StreamArtifactProjection';
import { SessionState } from '@controllers/session/SessionState';
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
  type RunIdentity,
  type StorageKey,
  type StreamPhase,
  type StreamTabId,
  type TodoItem,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { transcriptText } from '@shared/transcript';
import type { StreamTransitionCause } from '@shared/streams/streamStatus';
import { clearAllStreamStatusesForTest } from '@test/support/streamStatusTestUtils';
import { toolConversationEntry } from '@test/support/transcriptRowFixtures';
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
    ...focusOrderDescendants(
      parent,
      childRosters.get(),
      parentStream.get(),
      streams.get(),
    ),
  ];
}

function activeRows(parent: StreamTabId): readonly ActiveChildInfo[] {
  return activeSubagentsFor(parent, childRosters.get());
}

function retainedRows(parent: StreamTabId): readonly ActiveChildInfo[] {
  return retainedChildStreamsFor(parent, childRosters.get());
}

function visibleRows(parent: StreamTabId): readonly ActiveChildInfo[] {
  return visibleSubagentRows(parent, childRosters.get());
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

/** Drive a status transition on `session`'s machine; the resulting status
 *  fact reaches the adapter through the session's own event hub. */
function transitionStatus(
  session: SessionHandle,
  streamId: StreamTabId,
  phase: StreamPhase,
  reason: StreamTransitionCause,
): boolean {
  return session.status.transition(streamId, phase, reason);
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

/** Register streams with the session transcript store. Attachment does this
 *  before any roster or edge fact in production, and the child-stream
 *  snapshots cover registered streams only. */
function trackStreams(
  session: SessionHandle,
  ...streamIds: StreamTabId[]
): void {
  for (const streamId of streamIds) session.transcripts.ensureStream(streamId);
}

function emitChildRoster(
  hub: SessionEventHub,
  parentStreamId: StreamTabId,
  items: readonly ActiveChildInfo[],
): void {
  hub.emit({
    scope: 'run',
    streamId: parentStreamId,
    event: { type: 'child.activity', parentStreamId, items },
  });
}

function emitParentEdge(
  hub: SessionEventHub,
  childStreamId: StreamTabId,
  parentStreamId: StreamTabId | null,
): void {
  hub.emit({
    scope: 'session',
    event: {
      type: 'setParentStream',
      payload: { childStreamId, parentStreamId },
    },
  });
}

function emitRemoveStream(hub: SessionEventHub, streamId: StreamTabId): void {
  hub.emit({
    scope: 'session',
    event: { type: 'removeStream', payload: { streamId } },
  });
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

function emitRunStart(
  hub: SessionEventHub,
  streamId: StreamTabId,
  executionId: ExecutionId,
  identity: RunIdentity,
  userFollowUpSupport?: UserFollowUpSupport,
): void {
  hub.emit({
    scope: 'run',
    streamId,
    event: {
      type: 'run.start',
      streamId,
      executionId,
      identity,
      ...(userFollowUpSupport === undefined ? {} : { userFollowUpSupport }),
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

/** Mark a stream as a native tool-use agent that can accept child follow-ups:
 *  identity and follow-up support land with `run.start`, category and model
 *  with `run.config`, read back through the shared metadata mirror. */
function markToolUseAgent(hub: SessionEventHub, streamId: StreamTabId): void {
  const executionId = 'follow-up-exec' as ExecutionId;
  emitRunStart(
    hub,
    streamId,
    executionId,
    { kind: 'agent', agent: 'critic' },
    USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
  );
  emitRunConfig(hub, streamId, executionId);
}

// Shared-metadata seeding for tests that drive `syncStreamLog` without a
// session adapter attached: bind a `SessionState` over the default session
// and write through its public API.
let metadataState: SessionState | undefined;

function seedStreamMetadata(
  streamId: StreamTabId,
  patch: Parameters<SessionState['updateStreamMetadata']>[1],
): void {
  if (!metadataState) {
    metadataState = new SessionState(defaultSession());
    bindChildStreamState(metadataState);
  }
  metadataState.updateStreamMetadata(streamId, patch);
  invalidateChildStreams();
}

/** Mark a stream as workflow-category in the shared stream metadata. */
function markWorkflow(streamId: StreamTabId): void {
  seedStreamMetadata(streamId, { agentCategory: AgentCategory.Workflow });
}

/** Unfinalized tool-row entry with empty render text fields. */
function toolEntry(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  options: { outputText?: string; status?: 'in_progress' | 'completed' } = {},
) {
  return toolConversationEntry(id, {
    toolName,
    input,
    outputText: options.outputText ?? '',
    status: options.status ?? 'completed',
  });
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

afterEach(() => {
  clearAllStreamStatusesForTest(defaultSession().status);
  if (metadataState) {
    unbindChildStreamState(metadataState);
    metadataState = undefined;
  }
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

  it('initialises every new slice with empty subagent and bypass defaults', () => {
    setStatus(root, STREAM_PHASE.RUNNING);
    const slice = streams.get().get(root);
    expect(slice).toBeDefined();
    expect(activeRows(root)).toEqual([]);
    expect(slice?.bypass).toEqual({
      bash: false,
      toolEdit: false,
      superYolo: false,
    });
  });

  it('prunes parent edges when a stream is removed', () => {
    withRunFacts((hub, session) => {
      trackStreams(session, root, child1, child2);
      emitParentEdge(hub, child1, root);
      emitParentEdge(hub, child2, root);
      expect(parentStream.get().get(child1)).toBe(root);
      expect(parentStream.get().get(child2)).toBe(root);

      // Removing a child drops its own edge but leaves siblings intact.
      setStatus(child1, STREAM_PHASE.RUNNING);
      emitRemoveStream(hub, child1);
      expect(parentStream.get().has(child1)).toBe(false);
      expect(parentStream.get().get(child2)).toBe(root);

      // Removing the parent prunes every edge that pointed at it.
      setStatus(root, STREAM_PHASE.RUNNING);
      emitRemoveStream(hub, root);
      expect(parentStream.get().has(child2)).toBe(false);
    });
  });

  it('refuses focus for a removed stream identity', () => {
    withRunFacts((hub) => {
      setStatus(child1, STREAM_PHASE.RUNNING);
      focusStream(child1);
      expect(activeStreamId.get()).toBe(child1);

      emitRemoveStream(hub, child1);
      expect(activeStreamId.get()).toBeUndefined();

      // A fact that arrives after the row is gone must not pull the view back
      // onto it, with or without an existing focus.
      focusStream(child1);
      expect(activeStreamId.get()).toBeUndefined();
      focusStream(child1, { onlyIfUnset: true });
      expect(activeStreamId.get()).toBeUndefined();
    });
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
    withRunFacts((hub, session) => {
      activeStreamId.set(root);
      trackStreams(session, root, child1);
      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.RUNNING, 'agent-1'),
      ]);
      emitParentEdge(hub, child1, root);
      setStatus(child1, STREAM_PHASE.WAITING);

      expect(orderedSessionDescendants(root)[0]).toBe(child1);

      // Production ordering: the untrack path drops the child from the
      // roster before the removal fact lands, so removal never has to scrub
      // the roster itself.
      emitChildRoster(hub, root, []);
      emitRemoveStream(hub, child1);

      expect(isChildStreamRemoved(child1)).toBe(true);
      expect(activeRows(root)).toEqual([]);
      expect(orderedSessionDescendants(root)[0]).toBeUndefined();

      // A stale roster cannot resurrect the tombstoned child — not even as a
      // retained history row: the applier filters removed children at write
      // time.
      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.RUNNING, 'agent-1'),
      ]);
      expect(retainedRows(root)).toEqual([]);
      expect(activeRows(root)).toEqual([]);
      expect(visibleRows(root)).toEqual([]);
    });
  });

  it('updates retained child rows when a failed subagent leaves the active list', () => {
    withRunFacts((hub, session) => {
      trackStreams(session, root);
      emitChildRoster(hub, root, [
        childRosterRow('codex', child1, STREAM_PHASE.RUNNING, 'agent-1'),
      ]);
      // A later, empty roster clears active membership; the retained row
      // survives and later phase transitions still merge into it.
      emitChildRoster(hub, root, []);

      expect(subagentExecutionLabels.get().get('agent-1')).toBe('codex');

      transitionStatus(session, child1, STREAM_PHASE.FAILED, 'restart-repair');

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
    withRunFacts((hub, session) => {
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);
      expect(parentStream.get().get(child1)).toBe(root);

      emitParentEdge(hub, child1, null);

      expect(parentStream.get().has(child1)).toBe(false);
    });
  });

  it('projects phase stages onto the shared stream state and leaves rounds alone', () => {
    withRunFacts((hub, session) => {
      // `run.config` resolves the category and RUNNING mints the execution
      // state — the production order in which stage facts arrive.
      emitRunConfig(hub, child1, 'exec-stage-child' as ExecutionId);
      transitionStatus(session, child1, STREAM_PHASE.RUNNING, 'lifecycle');
      emitStageStart(hub, child1, {
        id: 'phase-2',
        label: 'Reduce',
        kind: 'phase',
        index: 1,
        total: 3,
      });

      expect(streamStateFor(child1)?.stage).toEqual({
        kind: 'phase',
        label: 'Reduce',
        index: 1,
        total: 3,
      });

      emitRunConfig(hub, root, 'exec-stage-root' as ExecutionId);
      transitionStatus(session, root, STREAM_PHASE.RUNNING, 'lifecycle');
      emitStageStart(hub, root, {
        id: 'round-2',
        label: 'round 2',
        kind: 'round',
        index: 1,
        total: 4,
      });

      expect(streamStateFor(root)?.stage).toEqual({
        kind: 'round',
        index: 1,
        total: 4,
      });
    });
  });

  it('keeps a dynamically opened phase positionless', () => {
    withRunFacts((hub, session) => {
      emitRunConfig(hub, child1, 'exec-stage-child' as ExecutionId);
      transitionStatus(session, child1, STREAM_PHASE.RUNNING, 'lifecycle');
      emitStageStart(hub, child1, {
        id: 'phase-x',
        label: 'Cleanup',
        kind: 'phase',
      });

      expect(streamStateFor(child1)?.stage).toEqual({
        kind: 'phase',
        label: 'Cleanup',
      });
    });
  });

  it('scopes focus order and the transcript viewport by child topology facts', () => {
    withRunFacts((hub, session) => {
      activeStreamId.set(root);
      trackStreams(session, root, child1);
      setStatus(child1, STREAM_PHASE.RUNNING);

      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.RUNNING, 'agent-1'),
      ]);
      emitParentEdge(hub, child1, root);

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
  ])(
    'keeps unfinished todo and plan chrome across stream phases: $name',
    ({ foregroundOpen, hasPlan, todos, expected }) => {
      expect(shouldShowTodosPlanPanel({ foregroundOpen, hasPlan, todos })).toBe(
        expected,
      );
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

  it.each([
    {
      name: 'before start',
      canStartRootRun: true,
      streamId: undefined,
      status: undefined,
      hasActiveToolUseFlow: false,
      expected: true,
    },
    {
      name: 'while a tool-use chat is waiting',
      canStartRootRun: false,
      streamId: root,
      status: STREAM_PHASE.WAITING,
      hasActiveToolUseFlow: true,
      expected: true,
    },
    {
      name: 'while a tool-use chat is running',
      canStartRootRun: false,
      streamId: root,
      status: STREAM_PHASE.RUNNING,
      hasActiveToolUseFlow: true,
      expected: false,
    },
    {
      name: 'waiting without an active tool-use flow',
      canStartRootRun: false,
      streamId: root,
      status: STREAM_PHASE.WAITING,
      hasActiveToolUseFlow: false,
      expected: false,
    },
  ])(
    'allows model selection $name',
    ({ canStartRootRun, streamId, status, hasActiveToolUseFlow, expected }) => {
      expect(
        chatTuiCanSelectModel({
          canStartRootRun,
          streamId,
          status,
          hasActiveToolUseFlow,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: 'before the root stream resolves',
      runPending: true,
      streamId: undefined,
      status: undefined,
      expected: true,
    },
    {
      name: 'while the root stream is actively responding',
      runPending: true,
      streamId: root,
      status: STREAM_PHASE.RUNNING,
      expected: true,
    },
    {
      name: 'while the root stream waits',
      runPending: true,
      streamId: root,
      status: STREAM_PHASE.WAITING,
      expected: false,
    },
    {
      name: 'after the root stream failed',
      runPending: true,
      streamId: root,
      status: STREAM_PHASE.FAILED,
      expected: false,
    },
    {
      name: 'after the root stream was cancelled',
      runPending: true,
      streamId: root,
      status: STREAM_PHASE.CANCELLED,
      expected: false,
    },
    {
      name: 'after the root stream completed',
      runPending: true,
      streamId: root,
      status: STREAM_PHASE.COMPLETED,
      expected: false,
    },
    {
      name: 'with no run pending',
      runPending: false,
      streamId: root,
      status: STREAM_PHASE.RUNNING,
      expected: false,
    },
  ])(
    'only reports Ctrl-C stoppable $name',
    ({ runPending, streamId, status, expected }) => {
      expect(chatTuiCanStopActiveRun({ runPending, streamId, status })).toBe(
        expected,
      );
    },
  );

  it.each([
    {
      name: 'while the visible stream is already live',
      runPending: false,
      streamId: root,
      status: STREAM_PHASE.RUNNING,
      expected: true,
    },
    {
      name: 'with no visible stream resolved',
      runPending: false,
      streamId: undefined,
      status: STREAM_PHASE.RUNNING,
      expected: false,
    },
    {
      name: 'while the visible stream waits',
      runPending: false,
      streamId: root,
      status: STREAM_PHASE.WAITING,
      expected: false,
    },
  ])(
    'keeps Ctrl-C stoppable $name',
    ({ runPending, streamId, status, expected }) => {
      expect(chatTuiCanStopVisibleRun({ runPending, streamId, status })).toBe(
        expected,
      );
    },
  );

  it.each([
    {
      name: 'clean exit',
      exitArmed: false,
      canStopActiveRun: false,
      resumableIdle: false,
      expected: 'clean-exit',
    },
    {
      // Idle/WAITING (interruptible, not stoppable): exit WITHOUT interrupting
      // so the suspended tool-use flow record and terminal status survive.
      name: 'resumable idle',
      exitArmed: false,
      canStopActiveRun: false,
      resumableIdle: true,
      expected: 'preserve-exit',
    },
    {
      name: 'interruptible run',
      exitArmed: false,
      canStopActiveRun: true,
      resumableIdle: false,
      expected: 'interrupt-and-arm-exit',
    },
    {
      name: 'armed exit',
      exitArmed: true,
      canStopActiveRun: true,
      resumableIdle: false,
      expected: 'force-exit',
    },
  ])(
    'resolves the TUI Ctrl-C action for $name',
    ({ exitArmed, canStopActiveRun, resumableIdle, expected }) => {
      expect(
        chatTuiSigintAction({ exitArmed, canStopActiveRun, resumableIdle }),
      ).toBe(expected);
    },
  );

  it('selects the focused child stream as a follow-up target', () => {
    withRunFacts((hub, session) => {
      setStatus(root, STREAM_PHASE.WAITING);
      setStatus(child1, STREAM_PHASE.WAITING);
      markToolUseAgent(hub, child1);
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);

      activeStreamId.set(root);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({ kind: 'none' });

      activeStreamId.set(child1);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });
    });
  });

  it('ignores stale child row status when routing focused child follow-ups', () => {
    withRunFacts((hub, session) => {
      setStatus(root, STREAM_PHASE.WAITING);
      trackStreams(session, root, child1);
      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.COMPLETED),
      ]);
      setStatus(child1, STREAM_PHASE.RUNNING);
      markToolUseAgent(hub, child1);
      emitParentEdge(hub, child1, root);

      activeStreamId.set(child1);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });
    });
  });

  // Follow-up routing reads the focused child's own slice status; the status
  // a roster row was stamped with cannot keep a stopped child accepting
  // follow-ups.
  it('routes focused child follow-ups from the stream status, not the roster row', () => {
    withRunFacts((hub, session) => {
      setStatus(root, STREAM_PHASE.WAITING);
      trackStreams(session, root, child1);
      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.RUNNING),
      ]);
      setStatus(child1, STREAM_PHASE.CANCELLED);
      markToolUseAgent(hub, child1);
      emitParentEdge(hub, child1, root);

      activeStreamId.set(child1);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'reject',
        streamId: child1,
      });
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

    expect(
      focusedChildFollowUpRoute({
        activeStreamId: child1,
        parentStream: new Map([[child1, root]]),
        metadata: {
          identity: fixture.identity,
          userFollowUpSupport: fixture.userFollowUpSupport,
          agentCategory: fixture.category,
          creationTimestamp: 0,
        },
        streams: streams.get(),
      }),
    ).toEqual({ kind: fixture.expected, streamId: child1 });
  });

  it.each([
    {
      name: 'identity',
      metadata: {
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
        agentCategory: AgentCategory.ToolUse,
      },
    },
    {
      name: 'runtime support',
      metadata: {
        identity: { kind: 'agent' as const, agent: 'critic' },
        agentCategory: AgentCategory.ToolUse,
      },
    },
    {
      name: 'category',
      metadata: {
        identity: { kind: 'agent' as const, agent: 'critic' },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      },
    },
  ])('fails closed when child $name metadata is missing', ({ metadata }) => {
    setStatus(child1, STREAM_PHASE.RUNNING);

    expect(
      focusedChildFollowUpRoute({
        activeStreamId: child1,
        parentStream: new Map([[child1, root]]),
        metadata: { creationTimestamp: 0, ...metadata },
        streams: streams.get(),
      }),
    ).toEqual({ kind: 'reject', streamId: child1 });
  });

  it('fails closed when focused child status is missing while leaving root routing unchanged', () => {
    withRunFacts((hub, session) => {
      mintSlice(child1);
      markToolUseAgent(hub, child1);
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);

      activeStreamId.set(child1);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'reject',
        streamId: child1,
      });
      activeStreamId.set(root);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({ kind: 'none' });
    });
  });

  it('mirrors running child status events into focused child routing', () => {
    withRunFacts((hub, session) => {
      setStatus(root, STREAM_PHASE.WAITING);
      trackStreams(session, root, child1);
      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.COMPLETED),
      ]);
      // The child leaves the roster: its row is retained for display and
      // later phase transitions keep merging into it.
      emitChildRoster(hub, root, []);
      setStatus(child1, STREAM_PHASE.CANCELLED);
      markToolUseAgent(hub, child1);

      transitionStatus(session, child1, STREAM_PHASE.RUNNING, 'restart-repair');
      // The RUNNING transition resets the child's per-run metadata; the edge
      // fact lands after it, as the parent-link plumbing does for a real run.
      emitParentEdge(hub, child1, root);

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
    withRunFacts((hub, session) => {
      setStatus(root, STREAM_PHASE.WAITING);
      trackStreams(session, root, child1);
      emitChildRoster(hub, root, [
        childRosterRow('critic', child1, STREAM_PHASE.RUNNING),
      ]);
      emitChildRoster(hub, root, []);
      setStatus(child1, STREAM_PHASE.RUNNING);
      markToolUseAgent(hub, child1);
      emitParentEdge(hub, child1, root);

      transitionStatus(
        session,
        child1,
        STREAM_PHASE.CANCELLED,
        'restart-repair',
      );

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
    withRunFacts((hub, session) => {
      // The owner must be a row of the current state lifetime: focus never
      // lands on a stream identity retired by an earlier `resetCliState`.
      setStatus(root, STREAM_PHASE.RUNNING);
      activeStreamId.set(child1);

      expect(
        transitionStatus(session, child1, STREAM_PHASE.RUNNING, 'lifecycle'),
      ).toBe(true);
      // The edge lands after RUNNING resets the child's per-run metadata.
      emitParentEdge(hub, child1, root);
      expect(
        transitionStatus(session, child1, STREAM_PHASE.COMPLETED, 'lifecycle'),
      ).toBe(true);
      expect(activeStreamId.get()).toBe(root);
    });
  });

  it('returns a user-stopped focused child to its immediate owner', () => {
    withRunFacts((hub, session) => {
      setStatus(root, STREAM_PHASE.RUNNING);
      activeStreamId.set(child1);

      expect(
        transitionStatus(session, child1, STREAM_PHASE.RUNNING, 'lifecycle'),
      ).toBe(true);
      emitParentEdge(hub, child1, root);
      expect(
        transitionStatus(session, child1, STREAM_PHASE.CANCELLED, 'user-stop'),
      ).toBe(true);
      expect(activeStreamId.get()).toBe(root);
    });
  });

  it('does not auto-return for WAITING, repair, unrelated, or detached status events', () => {
    withRunFacts((hub, session) => {
      const detachedChild = 'detached-child' as StreamTabId;

      transitionStatus(session, child1, STREAM_PHASE.RUNNING, 'lifecycle');
      emitParentEdge(hub, child1, root);
      activeStreamId.set(child1);
      transitionStatus(session, child1, STREAM_PHASE.WAITING, 'wait');
      expect(activeStreamId.get()).toBe(child1);

      transitionStatus(session, child2, STREAM_PHASE.RUNNING, 'lifecycle');
      transitionStatus(session, child2, STREAM_PHASE.FAILED, 'lifecycle');
      expect(activeStreamId.get()).toBe(child1);

      transitionStatus(session, child1, STREAM_PHASE.FAILED, 'restart-repair');
      expect(activeStreamId.get()).toBe(child1);

      transitionStatus(
        session,
        detachedChild,
        STREAM_PHASE.RUNNING,
        'lifecycle',
      );
      activeStreamId.set(detachedChild);
      transitionStatus(
        session,
        detachedChild,
        STREAM_PHASE.COMPLETED,
        'lifecycle',
      );
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

  function assistant(id: string, pendingEmbeddedFollowup = false) {
    return {
      id,
      role: 'assistant',
      text: id,
      row: {
        kind: 'assistant',
        id,
        timestamp: 0,
        level: 'info',
        text: transcriptText(id),
        streaming: false,
        ...(pendingEmbeddedFollowup ? { pendingEmbeddedFollowup } : {}),
      },
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

  it('renders typed loaded images in source order and excludes ordinary file lists', () => {
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
    // Every reported attachment stays on the row — the loaded media, the
    // audio the terminal cannot preview, and the plain input file — with the
    // media subset kept beside them rather than instead of them.
    expect(entries[0]).toMatchObject({
      role: 'media',
      finalized: true,
      row: {
        kind: 'fileList',
        counts: { loaded: 5, failed: 0, total: 5 },
        media: [
          { path: '/private/tmp/loaded.png' },
          { path: '/private/tmp/loaded.png' },
          { path: '/private/tmp/paper.pdf' },
          { path: '/private/tmp/audio.wav' },
        ],
      },
    });
    expect(transcriptEntryLayout(entries[0]).lines).toEqual([
      'Files (5/5 loaded)',
      '  ⎿ ✓ /private/tmp/loaded.png [image, 8.5 KiB]',
      '    ✓ /private/tmp/loaded.png [image, 8.5 KiB]',
      '    ✓ /private/tmp/paper.pdf [image, 8 KiB]',
      '    ✓ /private/tmp/audio.wav [audio, 4 KiB]',
      '    ✓ paper.tex',
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
        '<subagent-progress id="abc" agent="prover" type="todos" completed="1" active="1" pending="0">',
        '  ● check',
        '  ◐ prove',
        '</subagent-progress>',
      ].join('\n'),
    );

    syncStreamLog(root);

    const entries = streamEntries(root);
    expect(entryTexts(root)).toEqual([
      [
        'Waiting for the child.',
        '⟳ prover · todos · 1 done, 1 active, 0 pending',
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
      text: 'Model request failed (no retry available)',
      finalized: true,
    });
    expect(transcriptEntryLayout(entries[0]!, { width: 200 }).lines)
      .toMatchInlineSnapshot(`
      [
        "! Model request failed (no retry available)",
        "  ⎿ message: HTTP 400 Bad Request – status code without a body",
        "    provider: openai",
        "    userRetryable: false",
        "    rawErrorBody: {",
        "      "apiKey": "[redacted]"",
        "    }",
      ]
    `);
  });

  it('removes terminal control sequences from model-error reasons', () => {
    const logger = runTrace(root);
    logModelError(logger, 'Model request failed', {
      message: '\u001b[31mProvider failed\u001b[0m\u0007 \n retry later\u0085',
      userRetryable: false,
    });

    syncStreamLog(root);

    const lines = transcriptEntryLayout(streamEntries(root)[0]!, {
      width: 200,
    }).lines;
    expect(lines).toEqual([
      '! Model request failed',
      '  ⎿ message: Provider failed ',
      '     retry later',
      '    userRetryable: false',
    ]);
    for (const line of lines) {
      expect(line).not.toContain('\u001b');
      expect(line).not.toContain('\u0007');
      expect(line).not.toContain('\u0085');
    }
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

    const entry = streamEntries(root)[0]!;
    expect(entry.text).toContain('Model request failed with Bearer [redacted]');
    const body = transcriptEntryLayout(entry, { width: 400 }).lines.join('\n');
    expect(body).toContain('API_KEY=[redacted]');
    expect(body).toContain('Bearer [redacted]');
    expect(body).not.toContain(secret);
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
    // An opened stream with no delta says nothing yet, so it has no row.
    expect(slice?.entries).toEqual([]);

    thinking.append('private reasoning summary');

    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(true);
    // Reasoning is a compact `Thinking` row whose headline never quotes the
    // reasoning itself; the text is body content, elided at paint.
    expect(slice?.entries.map((entry) => entry.text)).toEqual(['Thinking']);

    thinking.finalize();
    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(false);

    const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    output.append('Visible answer.');

    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.thinkingActive).toBe(false);
    expect(slice?.entries.map((entry) => entry.text)).toEqual([
      'Thinking',
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
    markWorkflow(child1);
    patchStream(child1, (slice) => ({
      ...slice,
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

      expect(streamMetadataFor(child1)?.description).toBe(
        'Audit the compactness lemma.',
      );
      expect(streams.get().get(child1)?.latestLine).toBe(
        'The second lemma is valid.',
      );
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

  it('keeps an interrupted compaction replaceable until its provider outcome arrives', () => {
    const logger = runTrace(root);

    const activity = startCompactionActivity(logger);
    syncStreamLog(root);
    expect(streams.get().get(root)?.compactingActive).toBe(true);

    logUserMessage(logger, 'A later turn started.');
    syncStreamLog(root);

    let slice = streams.get().get(root);
    expect(slice?.compactingActive).toBe(false);
    expect(slice?.entries).toContainEqual(
      expect.objectContaining({
        id: `compaction:${activity.operationId}`,
        role: 'activity',
        finalized: false,
        activity: expect.objectContaining({ status: 'interrupted' }),
      }),
    );

    activity.finish('completed');
    syncStreamLog(root);

    slice = streams.get().get(root);
    expect(slice?.entries).toContainEqual(
      expect.objectContaining({
        id: `compaction:${activity.operationId}`,
        role: 'activity',
        finalized: true,
        activity: expect.objectContaining({ status: 'completed' }),
      }),
    );
  });

  it('finalizes unmatched compaction when the transcript settles', () => {
    const logger = runTrace(root);
    const activity = startCompactionActivity(logger);
    syncStreamLog(root);

    setStatus(root, STREAM_PHASE.WAITING);
    syncStreamLog(root);

    expect(streams.get().get(root)?.entries).toContainEqual(
      expect.objectContaining({
        id: `compaction:${activity.operationId}`,
        finalized: true,
        activity: expect.objectContaining({
          status: 'interrupted',
          finalized: true,
        }),
      }),
    );

    activity.finish('completed');
    syncStreamLog(root);

    expect(streams.get().get(root)?.entries).toContainEqual(
      expect.objectContaining({
        id: `compaction:${activity.operationId}`,
        finalized: true,
        activity: expect.objectContaining({
          status: 'interrupted',
          finalized: true,
        }),
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

  // Regression: a sync tick that fires after the turn-boundary `forceFinal`
  // promotion must not roll the entry back to
  // `finalized: false`. Without this guard,
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

    // Focusing the dormant stream is what requests the exact transcript:
    // the sync projects the full transcript for the active stream.
    activeStreamId.set(child1);
    syncStreamLog(child1);

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

    syncStreamLog(root, { forceFinal: true });

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
    withRunFacts((hub, session) => {
      rootStreamId.set(root);
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);
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
  });

  it('uses the focused child parent for local notices before root id is set', () => {
    withRunFacts((hub, session) => {
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);
      activeStreamId.set(child1);

      appendLocalAssistantTranscript('Slash command output.');

      expect(entryTexts(root)).toEqual(['Slash command output.']);
      expect(streamEntries(child1)).toEqual([]);
      expect(activeStreamId.get()).toBe(child1);
    });
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

  it('keeps local output live behind an unfinished model response', () => {
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

    expect(pending.map((entry) => entry.id)).toEqual([
      'model-response',
      'local-help',
    ]);
    expect(finalized).toEqual([]);
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
    withRunFacts((hub, session) => {
      const executionId = 'e9911-adapter' as ExecutionId;
      setStatus(child1, STREAM_PHASE.WAITING);
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);
      emitRunConfig(hub, child1, executionId);
      emitRunStart(
        hub,
        child1,
        executionId,
        { kind: 'agent', agent: 'search' },
        USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      );

      expect(streamMetadataFor(child1)?.userFollowUpSupport).toBe(
        USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      );
      focusStream(child1);
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'accept',
        streamId: child1,
      });

      emitRunStart(hub, child1, executionId, {
        kind: 'agent',
        agent: 'search',
      });

      expect(streamMetadataFor(child1)?.userFollowUpSupport).toBeUndefined();
      expect(chatTuiFocusedChildFollowUpRoute()).toEqual({
        kind: 'reject',
        streamId: child1,
      });
    });
  });

  it('keeps a session-scoped fact subscription live after state reset', () => {
    withRunFacts((hub, session) => {
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

      // The reset zeroed the artifact revision; the still-attached adapter
      // re-bumped it, and the fact landed in the canonical snapshot store.
      expect(streamArtifactRevision.get()).toBeGreaterThan(0);
      expect(projectStreamArtifacts(session.snapshots, nextRoot).todos).toEqual(
        todos,
      );
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
    withRunFacts((hub, session) => {
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

      expect(projectStreamArtifacts(session.snapshots, root).todos).toEqual(
        todos,
      );
    });
  });

  it('applies typed updatePlan run facts without host emission', () => {
    withRunFacts((hub, session) => {
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

      expect(projectStreamArtifacts(session.snapshots, root).plan).toEqual(
        plan,
      );
    });
  });

  it('invalidates a hydrated artifact memo on a live work-plan fact', () => {
    const streamId = 'hydrated-artifact-memo' as StreamTabId;
    const previousTodos: TodoItem[] = [
      {
        content: 'Previous durable task',
        status: TODO_STATUS.PENDING,
        activeForm: 'Keeping the previous durable task',
      },
    ];
    const nextTodos: TodoItem[] = [
      {
        content: 'Current durable task',
        status: TODO_STATUS.IN_PROGRESS,
        activeForm: 'Refreshing the durable task',
      },
    ];
    const session = defaultSession();
    const detach = attachSessionSignalsAdapter({
      events: session.events,
      session,
      snapshots: session.snapshots,
    });
    try {
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateTodos',
          streamId,
          todos: previousTodos,
        },
      });
      markArtifactStreamHydrated(streamId);
      expect(readStreamArtifacts(streamId)?.todos).toEqual(previousTodos);

      // The event changes the canonical snapshot store and must clear the
      // per-revision projection memo hydration populated.
      session.events.emit({
        scope: 'run',
        streamId,
        event: {
          type: 'updateTodos',
          streamId,
          todos: nextTodos,
        },
      });

      expect(readStreamArtifacts(streamId)?.todos).toEqual(nextTodos);
    } finally {
      detach();
      session.snapshots.evictAll();
    }
  });

  it('keeps a captured work-plan reader synchronized after focus moves', () => {
    withRunFacts((hub, session) => {
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

      const projection = projectStreamArtifacts(session.snapshots, root);
      expect(projection.plan).toEqual(nextPlan);
      expect(projection.todos).toEqual(nextTodos);
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
    withRunFacts((hub, session) => {
      emitRunConfig(hub, root, 'exec-stage-root' as ExecutionId);
      transitionStatus(session, root, STREAM_PHASE.RUNNING, 'lifecycle');
      emitStageStart(hub, root, {
        id: 'round-2',
        label: 'Round 2',
        kind: 'round',
        index: 1,
        total: 3,
      });

      expect(streamStateFor(root)?.stage).toEqual({
        kind: 'round',
        index: 1,
        total: 3,
      });
    });
  });

  it('applies direct non-round stage.start events to the phase slot, not the round slot', () => {
    withRunFacts((hub, session) => {
      emitRunConfig(hub, root, 'exec-stage-root' as ExecutionId);
      transitionStatus(session, root, STREAM_PHASE.RUNNING, 'lifecycle');
      emitStageStart(hub, root, {
        id: 'phase-1',
        label: 'Compile phase',
        kind: 'phase',
        index: 0,
      });

      expect(streamStateFor(root)?.stage).toEqual({
        kind: 'phase',
        label: 'Compile phase',
        index: 0,
      });
    });
  });

  it('applies direct child activity and parent-link facts without host emission', () => {
    withRunFacts((hub, session) => {
      const child: ActiveChildInfo = childRosterRow(
        'critic',
        child1,
        STREAM_PHASE.RUNNING,
        'agent-1',
      );

      trackStreams(session, root, child1, child2);
      emitChildRoster(hub, root, [child]);
      emitParentEdge(hub, child2, root);

      // A live roster row is active, not retained: retention is decided by
      // `finishedAt`, which only a later roster drop stamps.
      expect(activeRows(root)).toEqual([child]);
      expect(retainedRows(root)).toEqual([]);
      expect(visibleRows(root)).toEqual([child]);
      expect(parentStream.get().get(child2)).toBe(root);
    });
  });

  it('applies direct usage events without host emission', () => {
    withRunFacts((hub, session) => {
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
      expect(
        projectStreamArtifacts(session.snapshots, root).cumulativeUsage,
      ).toEqual({
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
      expect(streams.get().has(child1)).toBe(true);
      const metadata = streamMetadataFor(child1);
      expect(metadata?.agentCategory).toBe(AgentCategory.ToolUse);
      expect(metadata?.description).toBe(
        'Checking the local compactness claim.',
      );

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
    withRunFacts((hub, session) => {
      // The agent identity arrives with `run.start` while `run.config`
      // supplies model/category through the summary mirror (#9947); RUNNING
      // then mints the execution state that conversation progress lands on.
      emitRunStart(hub, root, 'exec-config' as ExecutionId, {
        kind: 'agent',
        agent: 'search',
      });
      emitRunConfig(hub, root, 'exec-config', {
        input: ['src/Main.lean'],
        context: ['notes/proof.md'],
        output: ['build/Main.olean'],
      });
      transitionStatus(session, root, STREAM_PHASE.RUNNING, 'lifecycle');
      hub.emit({
        scope: 'run',
        streamId: root,
        event: {
          type: 'conversation.progress',
          progress: { toolCallCount: 3 },
        },
      });

      const metadata = streamMetadataFor(root);
      expect(metadata?.identity).toEqual({ kind: 'agent', agent: 'search' });
      expect(metadata?.config?.model).toBe('kimi26T');
      expect(metadata?.agentCategory).toBe(AgentCategory.ToolUse);
      expect(streamStateFor(root)?.conversationProgress).toEqual({
        toolCallCount: 3,
      });
    });
  });

  it('streams every workflow output round into selected-agent state', () => {
    withRunFacts((hub, session) => {
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

      expect(
        projectStreamArtifacts(session.snapshots, root).outputFilesByRound,
      ).toEqual({
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
    withRunFacts((hub, session) => {
      const artifacts = () => projectStreamArtifacts(session.snapshots, root);
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

      expect(artifacts()).toMatchObject({
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
      expect(artifacts().missingOutputsByRound).toEqual({});

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

      expect(artifacts().missingOutputsByRound).toEqual({});
      expect(artifacts().compileFailuresByRound[0]).toHaveLength(1);
    });
  });

  it('applies direct usage sequences exactly once', () => {
    withRunFacts((hub, session) => {
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
      expect(
        projectStreamArtifacts(session.snapshots, root).cumulativeUsage,
      ).toEqual({
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

      const metadata = streamMetadataFor(child1);
      expect(metadata?.config?.model).toBe('kimi26T');
      expect(metadata?.agentCategory).toBe(AgentCategory.ToolUse);
    });
  });

  it('refreshes queued follow-up display when an active follow-up is sent', () => {
    setStatus(root, STREAM_PHASE.RUNNING);
    withRunFacts((hub, session) => {
      const lease = session.followUps.claimLive(root, 'flow')!;
      const queue = session.followUps.queue(lease);
      try {
        queue.enqueue({ text: 'Keep the proof under one page.' });
        const revisionBefore = sessionStateRevision.get();
        hub.emit({
          scope: 'session',
          event: {
            type: 'followUpSent',
            payload: { streamId: root },
          },
        });

        // The fact's remaining job is the repaint: bump the shared-state
        // revision so renderers re-read the session-owned queue.
        expect(sessionStateRevision.get()).toBeGreaterThan(revisionBefore);
        expect(queuedFollowUpsFor(root)).toEqual([
          'Keep the proof under one page.',
        ]);

        queue.drainItems();
        hub.emit({
          scope: 'session',
          event: {
            type: 'updateQueuedFollowUps',
            payload: { streamId: root },
          },
        });

        expect(queuedFollowUpsFor(root)).toEqual([]);
      } finally {
        session.followUps.terminalize(root);
      }
    });
  });

  it('keeps latest usage separate from cumulative resume usage', () => {
    withRunFacts((hub, session) => {
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
      expect(
        projectStreamArtifacts(session.snapshots, root).cumulativeUsage,
      ).toEqual({
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
    withRunFacts((hub, session) => {
      trackStreams(session, root);
      emitChildRoster(hub, root, [
        childRosterRow('a', child1, undefined, 'e1'),
        childRosterRow('b', child2, undefined, 'e2'),
      ]);
      emitParentEdge(hub, child1, root);
      emitParentEdge(hub, child2, root);
      setStatus(child1, STREAM_PHASE.RUNNING);
      setStatus(child2, STREAM_PHASE.RUNNING);
      expect(orderedSessionDescendants(root)).toEqual([child1, child2]);
    });
  });

  it('retains an inactive child session with history', () => {
    // An edge observed before any roster tick still makes the child
    // focusable once its slice exists — no roster row required.
    withRunFacts((hub, session) => {
      trackStreams(session, child1);
      emitParentEdge(hub, child1, root);
      setStatus(root, STREAM_PHASE.WAITING);
      setStatus(child1, STREAM_PHASE.WAITING);

      expect(orderedSessionDescendants(root)).toEqual([child1]);
    });
  });
});
