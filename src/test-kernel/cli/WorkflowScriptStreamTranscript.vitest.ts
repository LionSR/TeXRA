// A detached delegate_multi_agents run owns a child stream. Its phases and
// typed task records render through the focused-child viewport, while the
// workflow-specific header identifies the kind of child execution.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest';

import '@test/support/defaultSessionTestSetup';
import { defaultSession } from '@agent/runtime/SessionHandle';

import {
  advanceStaticTranscriptState,
  buildStaticTranscriptState,
  StaticConversationTranscript,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import {
  isFinalizedTranscriptRow,
  transcriptRowHeadline,
} from '@cli/chat/tui/panes/transcriptEntries';
import {
  activeStreamId,
  closeForegroundReader,
  openTranscriptReader,
  openWorkflowPopup,
  patchStream,
  resetCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import {
  bindChildStreamState,
  invalidateChildStreams,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import {
  subscribeStreamLog,
  syncStreamLog,
} from '@cli/chat/tui/state/subscribeStreamLog';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { SessionState } from '@controllers/session/SessionState';
import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type StreamLogEntry,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@shared/transcript';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { setCliStreamPhase } from '@test/support/cliStreamStatus';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import { clearAllStreamStatusesForTest } from '@test/support/streamStatusTestUtils';
import { loadInk } from '@test/support/inkTestHarness.ts';
import { splitTranscriptEntries } from '@test/support/transcriptRowFixtures';
import { createRunTrace } from '@transcript';
import type { StreamSummaryMeta } from '@transcript/StreamLogStore';

// The `workflow-script#` prefix is what marks this stream as a child run whose
// full log output surfaces when focused.
const STREAM_ID = 'workflow-script#exec-1' as StreamTabId;
const PARENT_STREAM_ID = 'parent' as StreamTabId;
const SESSION_META = {
  agent: 'research',
  category: 'workflow',
  model: 'deepseekT',
  modelSource: 'builtin-default',
  cwd: '/tmp/project',
  apiMode: 'personal',
  approvalPolicy: 'yolo',
  canDelegate: true,
  transcriptMode: 'persistent',
  version: '0.39.6',
} as const;

// Full-log rendering keys on the parsed identity, not the stream-id prefix:
// this stream is a workflow-script child run.
const WORKFLOW_IDENTITY = {
  kind: 'multiAgentWorkflow',
  workflowName: 'draft-sections',
} as const;

// Identity/category/model metadata is shared-substrate state now: components
// and the log projection read it via `streamMetadataFor` from the bound
// `SessionState`, whose authority is the durable summary mirror. Seed it
// there, not on the CLI `StreamSlice`.
let boundState: SessionState;

function seedStreamMeta(streamId: StreamTabId, meta: StreamSummaryMeta): void {
  defaultSession().transcripts.recordSummaryMeta(streamId, meta);
  invalidateChildStreams();
}

function seedWorkflowStreamMeta(): void {
  seedStreamMeta(STREAM_ID, {
    identity: WORKFLOW_IDENTITY,
    agentCategory: AgentCategory.Workflow,
    model: 'deepseekT',
  });
}

function openRunTrace(
  streamId: StreamTabId,
): ReturnType<typeof createRunTrace> {
  const runTrace = createRunTrace(streamId, defaultSession().transcripts);
  onTestFinished(() => runTrace.dispose());
  return runTrace;
}

async function renderStaticTranscript(): Promise<string> {
  const { ink, React } = await loadInk();
  return ink.renderToString(
    React.createElement(StaticConversationTranscript, {
      ownerKey: 'root',
      scrollbackStreamId: STREAM_ID,
      width: 80,
    }),
    { columns: 80 },
  );
}

type StaticState = ReturnType<typeof buildStaticTranscriptState>;

const STATIC_INPUTS = {
  childRosters: new Map(),
  meta: SESSION_META,
  ownerKey: 'root',
  parentStream: new Map(),
  scrollbackStreamId: STREAM_ID,
  width: 80,
} as const;

/** A cold build over the current slice, or one ordinary stream-sync tick
 *  advancing `previous` to it. */
function appendItems(
  previous?: StaticState,
  overrides: Partial<Parameters<typeof buildStaticTranscriptState>[0]> = {},
): StaticState {
  return previous === undefined
    ? buildStaticTranscriptState({
        ...STATIC_INPUTS,
        repaintEpoch: 0,
        streams: streams.get(),
        ...overrides,
      })
    : advanceStaticTranscriptState(previous, {
        ...STATIC_INPUTS,
        streams: streams.get(),
        ...overrides,
      });
}

function staticEntries({ items }: StaticState): readonly TranscriptRow[] {
  return items
    .filter((item) => item.kind === 'entry')
    .map((item) => item.entry);
}

function entryIds(state: StaticState): string[] {
  return staticEntries(state).map((entry) => entry.id);
}

function entryTexts(state: StaticState): string[] {
  return staticEntries(state).map(transcriptRowHeadline);
}

function transcriptEntry(id: string): StreamLogEntry | undefined {
  return defaultSession()
    .transcripts.get(STREAM_ID)
    ?.getRange(0)
    .find((entry) => entry.id === id);
}

function streamSlice() {
  return streams.get().get(STREAM_ID);
}

function setStatus(status: StreamPhase): void {
  setCliStreamPhase({ streamId: STREAM_ID, status });
}

function streamEntries(): readonly TranscriptRow[] {
  return streamSlice()?.entries ?? [];
}

/** "Finalized" is derived now: a row is printable into append-only scrollback
 *  when the slice's promotion frontier has reached it or it settles on its
 *  own. These suites assert the per-row flag the fold used to store. */
function finalizedFlags(entries: readonly TranscriptRow[]): boolean[] {
  const frontier = streamSlice()?.finalizedFrontier ?? 0;
  return entries.map((row, index) =>
    isFinalizedTranscriptRow(row, index, frontier),
  );
}

function expectOutputOrder(output: string, markers: readonly string[]): void {
  for (const [index, marker] of markers.entries()) {
    if (index === 0) continue;
    expect(output.indexOf(markers[index - 1])).toBeLessThan(
      output.indexOf(marker),
    );
  }
}

beforeEach(async () => {
  resetCliState();
  clearAllStreamStatusesForTest(defaultSession().status);
  await defaultSession().transcripts.clear();
  boundState = new SessionState(defaultSession());
  bindChildStreamState(boundState);
  seedWorkflowStreamMeta();
  patchStream(STREAM_ID, (slice) => ({ ...slice }));
});

afterEach(() => {
  unbindChildStreamState(boundState);
  resetCliState();
});

describe('CLI workflow-script child-stream transcript', () => {
  it('loads a complete workflow projection for its popup and Ctrl-T log', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    for (let index = 0; index < 2_001; index++) {
      runTrace.trace.emit({
        type: 'workflow.call',
        logId: `task-${index}`,
        call: {
          id: `call-${index}`,
          label: `Call ${index}`,
          status: 'planned',
        },
      });
    }
    runTrace.trace.info('Full workflow log detail', {
      messageType: MESSAGE_TYPES.DEFAULT,
    });
    patchStream(PARENT_STREAM_ID, (slice) => ({ ...slice }));
    activeStreamId.set(PARENT_STREAM_ID);

    syncStreamLog(defaultSession(), STREAM_ID);
    expect(streamEntries()).toHaveLength(2_000);
    expect(streamEntries().some((row) => row.id === 'task-0')).toBe(false);

    const dispose = subscribeStreamLog(defaultSession());
    try {
      openWorkflowPopup(STREAM_ID);
      await waitFor(() => streamEntries().length === 2_002);
      expect(streamEntries().some((row) => row.id === 'task-0')).toBe(true);
      expect(streamEntries().map(transcriptRowHeadline)).toContain(
        'Full workflow log detail',
      );

      openTranscriptReader(STREAM_ID);
      await waitFor(() => streamEntries().length === 2_002);

      closeForegroundReader();
      await waitFor(() => streamEntries().length === 2_000);
    } finally {
      dispose();
    }
  });

  it('keeps lifecycle headings for full-log SDK children', () => {
    const sdkStreamId = 'claude@agent-sdk#exec-1' as StreamTabId;
    // External-CLI agent sessions are full-log children too.
    seedStreamMeta(sdkStreamId, {
      identity: {
        kind: 'agent',
        agent: 'claude',
        tool: 'claude_code',
      },
      agentCategory: AgentCategory.ToolUse,
      model: 'claude-sonnet',
    });
    const runTrace = openRunTrace(sdkStreamId);
    onTestFinished(() => defaultSession().status.clearStream(sdkStreamId));
    runTrace.trace.openStage('Claude SDK session', {
      id: 'sdk-session',
      kind: 'session',
    });
    syncStreamLog(defaultSession(), sdkStreamId);

    expect(
      streams.get().get(sdkStreamId)?.entries.map(transcriptRowHeadline),
    ).toContain('Claude SDK session');
  });

  it('keeps planned call rows live until their terminal state is printable', () => {
    const runTrace = openRunTrace(STREAM_ID);
    for (const [id, label] of [
      ['core', 'Audit core'],
      ['extension', 'Audit extension'],
    ] as const) {
      runTrace.trace.emit({
        type: 'workflow.call',
        logId: `${id}-task`,
        call: { id, label, status: 'planned' },
      });
    }
    syncStreamLog(defaultSession(), STREAM_ID);

    const plannedEntries = streamEntries();
    expect(plannedEntries).toMatchObject([
      {
        id: 'core-task',
        kind: 'workflowTask',
        call: { id: 'core', status: 'planned' },
      },
      {
        id: 'extension-task',
        kind: 'workflowTask',
        call: { id: 'extension', status: 'planned' },
      },
    ]);
    expect(finalizedFlags(plannedEntries)).toEqual([false, false]);

    const plannedItems = appendItems();
    expect(staticEntries(plannedItems)).toHaveLength(0);

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'core-task',
      call: {
        id: 'core',
        label: 'Audit core',
        status: 'completed',
        model: 'deepseekT',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    const updatedEntries = streamEntries();
    expect(updatedEntries).toMatchObject([
      {
        id: 'core-task',
        // Model ids reach the row already projected to their runtime label
        // (`projectWorkflowCallEntry`), so the row never resolves one itself.
        call: { status: 'completed', model: 'DeepSeek V4 Flash (Thinking)' },
        line: 'Finished: Audit core · DeepSeek V4 Flash (Thinking)',
      },
      {
        id: 'extension-task',
        call: { status: 'planned' },
        line: 'Planned: Audit extension',
      },
    ]);
    expect(finalizedFlags(updatedEntries)).toEqual([true, false]);

    const updatedItems = appendItems(plannedItems);
    expect(entryTexts(updatedItems)).toEqual([
      'Finished: Audit core · DeepSeek V4 Flash (Thinking)',
    ]);
  });

  it('keeps a running task replaceable when cancellation precedes bridge cleanup', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'cancelled-running-task',
      call: {
        id: 'cancelled-running',
        label: 'Audit cancellation',
        status: 'running',
      },
    });
    setStatus(STREAM_PHASE.CANCELLED);

    // This exercises both terminal-status finalization entry points:
    // syncStreamLog's settled-prefix promotion and the explicit
    // end-of-stream projection used by the controller.
    syncStreamLog(defaultSession(), STREAM_ID, { forceFinal: true });

    const runningEntries = streamEntries();
    expect(runningEntries.at(0)).toMatchObject({
      line: 'Running: Audit cancellation',
      call: { status: 'running' },
    });
    expect(finalizedFlags(runningEntries)).toEqual([false]);
    let staticItems = appendItems();
    expect(staticEntries(staticItems)).toEqual([]);

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'cancelled-running-task',
      call: {
        id: 'cancelled-running',
        label: 'Audit cancellation',
        status: 'failed',
        error: 'The workflow ended before this call completed.',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    const settledEntries = streamEntries();
    expect(settledEntries).toHaveLength(1);
    expect(settledEntries).toMatchObject([
      {
        id: 'cancelled-running-task',
        call: {
          id: 'cancelled-running',
          status: 'failed',
        },
      },
    ]);
    expect(finalizedFlags(settledEntries)).toEqual([true]);
    staticItems = appendItems(staticItems);
    syncStreamLog(defaultSession(), STREAM_ID, { forceFinal: true });
    syncStreamLog(defaultSession(), STREAM_ID);
    staticItems = appendItems(staticItems);
    expect(entryTexts(staticItems)).toEqual([
      'Failed: Audit cancellation — The workflow ended before this call completed.',
    ]);
    expect(entryIds(staticItems)).toEqual(['cancelled-running-task']);
    const output = await renderStaticTranscript();
    expect(output).toContain('Failed: Audit cancellation');
    expect(output).not.toContain('Running: Audit cancellation');
  });

  it('keeps a cold-rebuilt planned task replaceable until not-reached cleanup settles it', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'cancelled-planned-task',
      call: {
        id: 'cancelled-planned',
        label: 'Audit later',
        status: 'planned',
      },
    });

    // Rebuild CLI state from the durable log after cancellation, before the
    // bridge has projected its not-reached terminal update. The shared
    // metadata mirror survives the CLI-state reset; only the slice must be
    // re-created (un-retiring the stream identity).
    resetCliState();
    patchStream(STREAM_ID, (slice) => ({ ...slice }));
    setStatus(STREAM_PHASE.CANCELLED);
    syncStreamLog(defaultSession(), STREAM_ID, { forceFinal: true });

    const plannedEntries = streamEntries();
    expect(plannedEntries.at(0)).toMatchObject({
      line: 'Planned: Audit later',
      call: { status: 'planned' },
    });
    expect(finalizedFlags(plannedEntries)).toEqual([false]);
    let staticItems = appendItems();
    expect(staticEntries(staticItems)).toEqual([]);

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'cancelled-planned-task',
      call: {
        id: 'cancelled-planned',
        label: 'Audit later',
        status: 'skipped',
        reason: 'not-reached',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    const settledEntries = streamEntries();
    expect(settledEntries).toHaveLength(1);
    expect(settledEntries).toMatchObject([
      {
        id: 'cancelled-planned-task',
        call: {
          id: 'cancelled-planned',
          status: 'skipped',
          reason: 'not-reached',
        },
      },
    ]);
    expect(finalizedFlags(settledEntries)).toEqual([true]);
    staticItems = appendItems(staticItems);
    syncStreamLog(defaultSession(), STREAM_ID, { forceFinal: true });
    syncStreamLog(defaultSession(), STREAM_ID);
    staticItems = appendItems(staticItems);
    expect(entryTexts(staticItems)).toEqual([
      'Skipped: Audit later — The workflow ended before this call was reached.',
    ]);
    expect(entryIds(staticItems)).toEqual(['cancelled-planned-task']);
    const output = await renderStaticTranscript();
    // The skipped marker distinguishes the row from a finished or failed one.
    expect(output).toContain('⊘ Skipped: Audit later');
    expect(output).toContain('The workflow ended before this call was');
    expect(output).not.toContain('Planned: Audit later');
  });

  it('keeps mixed cancelled settlement order identical live and cold', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    const phase = runTrace.trace.openStage('Cancellation audit', {
      id: 'cancel-phase',
      kind: 'phase',
    });
    appendLocalAssistantTranscript('Local cancellation checkpoint', STREAM_ID);
    syncStreamLog(defaultSession(), STREAM_ID);
    let liveItems = appendItems();
    expect(entryIds(liveItems)).toEqual([
      'cancel-phase',
      expect.stringMatching(/^local:/),
    ]);
    const beforeStatusOutput = await renderStaticTranscript();
    expect(beforeStatusOutput).toContain('◆ Cancellation audit');
    expect(beforeStatusOutput).toContain('Local cancellation checkpoint');

    const response = runTrace.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE, {
      stageId: phase.id,
    });
    response.append('Partial cancellation answer');
    runTrace.trace.toolStart({
      logId: 'cancel-tool',
      toolName: 'read',
      input: { path: 'paper.tex' },
    });
    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'cancel-plan',
      stageId: phase.id,
      call: {
        id: 'cancel-plan',
        label: 'Audit after cancellation',
        phase: 'Cancellation audit',
        status: 'planned',
      },
    });

    runTrace.handleStatus({
      type: 'status',
      streamId: STREAM_ID,
      phase: STREAM_PHASE.CANCELLED,
      cause: STREAM_TRANSITION_CAUSE.USER_STOP,
    });
    setStatus(STREAM_PHASE.CANCELLED);
    syncStreamLog(defaultSession(), STREAM_ID, { forceFinal: true });

    liveItems = appendItems(liveItems);
    expect(entryIds(liveItems)).toEqual([
      'cancel-phase',
      expect.stringMatching(/^local:/),
      response.id,
      'cancel-tool',
    ]);
    const afterStatusOutput = await renderStaticTranscript();
    expect(afterStatusOutput).toContain('Partial cancellation answer');
    expect(afterStatusOutput).toContain(
      'The stream ended before this tool completed.',
    );
    expect(afterStatusOutput).not.toContain(
      'Skipped: Audit after cancellation',
    );

    const syntheticEntry = streamEntries().find(
      (entry) => entry.origin === 'local',
    );
    expect(syntheticEntry).toBeDefined();
    expect(transcriptEntry(response.id)).toMatchObject({
      settlementSeqNo: 2,
      text: 'Partial cancellation answer',
    });
    expect(transcriptEntry('cancel-tool')).toMatchObject({
      settlementSeqNo: 3,
      data: {
        status: 'failed',
        error: 'The stream ended before this tool completed.',
      },
    });
    expect(transcriptEntry('cancel-plan')).not.toHaveProperty(
      'settlementSeqNo',
    );

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'cancel-plan',
      stageId: phase.id,
      call: {
        id: 'cancel-plan',
        label: 'Audit after cancellation',
        phase: 'Cancellation audit',
        status: 'skipped',
        reason: 'not-reached',
      },
    });
    phase.end('cancelled');
    syncStreamLog(defaultSession(), STREAM_ID);

    liveItems = appendItems(liveItems);
    expect(entryIds(liveItems)).toEqual([
      'cancel-phase',
      expect.stringMatching(/^local:/),
      response.id,
      'cancel-tool',
      'cancel-plan',
    ]);
    const liveOutput = await renderStaticTranscript();
    expect(liveOutput).toContain('Skipped: Audit after cancellation');

    resetCliState();
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: syntheticEntry ? [syntheticEntry] : [],
    }));
    setStatus(STREAM_PHASE.CANCELLED);
    syncStreamLog(defaultSession(), STREAM_ID);
    const coldItems = appendItems();

    expect(entryIds(coldItems)).toEqual(entryIds(liveItems));
    const coldOutput = await renderStaticTranscript();
    expect(coldOutput).toBe(liveOutput);
    expectOutputOrder(coldOutput, [
      '◆ Cancellation audit',
      'Local cancellation checkpoint',
      'Partial cancellation answer',
      'The stream ended before this tool completed.',
      'Skipped: Audit after cancellation',
    ]);
  });

  it('keeps a dynamic phase header above tasks introduced inside it', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    const phase = runTrace.trace.openStage('Dynamic audit', {
      id: 'dynamic-phase',
      kind: 'phase',
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'dynamic-task',
      stageId: phase.id,
      call: {
        id: 'dynamic',
        label: 'Inspect generated target',
        phase: 'Dynamic audit',
        status: 'running',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);
    const runningOutput = await renderStaticTranscript();
    expect(runningOutput).toContain('◆ Dynamic audit');
    expect(runningOutput).not.toContain('Finished: Inspect generated target');

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'dynamic-task',
      stageId: phase.id,
      call: {
        id: 'dynamic',
        label: 'Inspect generated target',
        phase: 'Dynamic audit',
        status: 'completed',
        model: 'deepseekT',
      },
    });
    phase.end('completed');
    syncStreamLog(defaultSession(), STREAM_ID);

    const output = await renderStaticTranscript();
    expect(output.indexOf('◆ Dynamic audit')).toBeLessThan(
      output.indexOf('Finished: Inspect generated target'),
    );
  });

  it('orders synthetic rows against legacy source sequence coordinates', async () => {
    // A host-synthesized row carries `origin: 'local'` plus the seq/settlement
    // coordinates the CLI captured when it appended it; a legacy source row
    // carries only its wire `seqNo`. The promotion frontier is set past every
    // row so ordering — not settlement — is what this pins.
    const beforeLoad = {
      kind: 'assistant',
      id: 'local-before-load',
      timestamp: 0,
      level: 'info',
      text: transcriptText('Before legacy load'),
      streaming: false,
      origin: 'local',
      seqNo: 0,
      settlementSeqNo: 0,
    } satisfies TranscriptRow;
    const legacyA = {
      kind: 'assistant',
      id: 'legacy-a',
      timestamp: 0,
      level: 'info',
      seqNo: 1,
      text: transcriptText('Legacy A'),
      streaming: false,
    } satisfies TranscriptRow;
    const legacyB = {
      kind: 'assistant',
      id: 'legacy-b',
      timestamp: 0,
      level: 'info',
      seqNo: 2,
      text: transcriptText('Legacy B'),
      streaming: false,
    } satisfies TranscriptRow;
    const afterLoad = {
      kind: 'assistant',
      id: 'local-after-load',
      timestamp: 0,
      level: 'info',
      text: transcriptText('After legacy load'),
      streaming: false,
      origin: 'local',
      seqNo: 2,
      settlementSeqNo: 2,
    } satisfies TranscriptRow;

    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [beforeLoad],
      finalizedFrontier: 1,
    }));
    let incrementalItems = appendItems();
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [beforeLoad, legacyA, legacyB],
      finalizedFrontier: 3,
    }));
    incrementalItems = appendItems(incrementalItems);
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [beforeLoad, legacyA, legacyB, afterLoad],
      finalizedFrontier: 4,
    }));
    incrementalItems = appendItems(incrementalItems);
    const coldItems = appendItems();
    expect(entryIds(incrementalItems)).toEqual([
      'local-before-load',
      'legacy-a',
      'legacy-b',
      'local-after-load',
    ]);
    expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
    const output = await renderStaticTranscript();
    expectOutputOrder(output, [
      'Before legacy load',
      'Legacy A',
      'Legacy B',
      'After legacy load',
    ]);
  });

  it('settles a repeated tool lifecycle at its terminal update', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    runTrace.trace.toolStart({
      logId: 'audit-tool',
      toolName: 'bash',
      input: { command: 'pwd' },
    });
    runTrace.trace.toolEnd({
      logId: 'audit-tool',
      status: TOOL_USE_STATUS.IN_PROGRESS,
      result: {
        toolName: 'bash',
        input: { command: 'pwd' },
        output: 'still running',
      },
    });
    runTrace.trace.info('Tool checkpoint recorded', {
      messageType: MESSAGE_TYPES.DEFAULT,
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    let incrementalItems = appendItems();
    expect(entryIds(incrementalItems)).not.toContain('audit-tool');

    runTrace.trace.toolEnd({
      logId: 'audit-tool',
      status: TOOL_USE_STATUS.COMPLETED,
      result: {
        toolName: 'bash',
        input: { command: 'pwd' },
        output: '/tmp/project',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);
    incrementalItems = appendItems(incrementalItems);
    const coldItems = appendItems();

    expect(entryIds(incrementalItems).at(-1)).toBe('audit-tool');
    expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
    const output = await renderStaticTranscript();
    expect(output.indexOf('Tool checkpoint recorded')).toBeLessThan(
      output.indexOf('pwd'),
    );
  });

  it('keeps cold static FILE_LIST order equal to incremental settlement order', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    runTrace.trace.toolStart({
      logId: 'audit-tool',
      toolName: 'bash',
      input: { command: 'pwd' },
    });
    runTrace.trace.domain({
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
        ],
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    const heldSplit = splitTranscriptEntries(
      streamEntries(),
      streamSlice()?.finalizedFrontier ?? 0,
      STREAM_PHASE.RUNNING,
    );
    expect(heldSplit.finalized).toEqual([]);
    expect(heldSplit.pending.map((entry) => entry.kind)).toEqual([
      'tool',
      'fileList',
    ]);

    let incrementalItems = appendItems();
    expect(staticEntries(incrementalItems).map((entry) => entry.kind)).toEqual(
      [],
    );

    runTrace.trace.toolEnd({
      logId: 'audit-tool',
      status: TOOL_USE_STATUS.COMPLETED,
      result: {
        toolName: 'bash',
        input: { command: 'pwd' },
        output: '/tmp/project',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);
    incrementalItems = appendItems(incrementalItems);
    const coldItems = appendItems();
    expect(staticEntries(incrementalItems).map((entry) => entry.kind)).toEqual([
      'fileList',
      'tool',
    ]);
    expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
    const output = await renderStaticTranscript();
    expect(output.indexOf('/private/tmp/loaded.png')).toBeLessThan(
      output.indexOf('bash'),
    );
  });

  it('projects round lifecycle separately from its ordinary log rows', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    const round = runTrace.trace.openStage('Round one', {
      id: 'round-one',
      kind: 'round',
    });
    runTrace.trace.info('Round work completed', {
      messageType: MESSAGE_TYPES.DEFAULT,
    });
    syncStreamLog(defaultSession(), STREAM_ID);

    const incrementalItems = appendItems();
    round.end('completed');
    syncStreamLog(defaultSession(), STREAM_ID);
    const coldItems = appendItems();
    expect(entryTexts(incrementalItems)).toEqual(['Round work completed']);
    expect(entryTexts(coldItems)).toEqual(entryTexts(incrementalItems));
    expect(streamSlice()?.taskGroups).toMatchObject([
      {
        id: 'round-one',
        name: 'Round one',
        kind: 'round',
        status: STREAM_PHASE.COMPLETED,
      },
    ]);
    const output = await renderStaticTranscript();
    expect(output).not.toContain('Round one');
    expect(output).toContain('Round work completed');
  });

  it('updates one visible task record from planned to completed', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'introduction-task',
      call: {
        id: 'introduction',
        label: 'Draft introduction',
        phase: 'Draft sections',
        status: 'planned',
      },
    });
    syncStreamLog(defaultSession(), STREAM_ID);
    expect(
      streamEntries()
        .filter((entry) => entry.id === 'introduction-task')
        .map(transcriptRowHeadline),
    ).toEqual(['Planned: Draft introduction']);

    const phase = runTrace.trace.openStage('Draft sections', {
      id: 'draft-phase',
      kind: 'phase',
    });
    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'introduction-task',
      stageId: phase.id,
      call: {
        id: 'introduction',
        label: 'Draft introduction',
        phase: 'Draft sections',
        status: 'running',
      },
    });
    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'introduction-task',
      stageId: phase.id,
      call: {
        id: 'introduction',
        label: 'Draft introduction',
        phase: 'Draft sections',
        status: 'completed',
        model: 'deepseekT',
        durationMs: 12_000,
        totalCostUsd: 0.002,
      },
    });
    phase.end('completed');

    syncStreamLog(defaultSession(), STREAM_ID);

    const entries = streamEntries();
    const texts = entries.map(transcriptRowHeadline);
    // The phase group row and the task's current state both surface.
    expect(texts).toContain('Draft sections');
    expect(texts).toContain(
      'Finished: Draft introduction · DeepSeek V4 Flash (Thinking) · 12s · $0.002',
    );
    expect(
      entries.filter((entry) => entry.id === 'introduction-task'),
    ).toHaveLength(1);

    // The phase group is a distinct `kind: 'phase'` header, not a plain
    // assistant row, so the CLI can render it as a divider between phases.
    const phaseIndex = texts.indexOf('Draft sections');
    expect(entries[phaseIndex]).toMatchObject({
      kind: 'phase',
      phaseLabel: 'Draft sections',
    });
    expect(finalizedFlags(entries)[phaseIndex]).toBe(true);

    // Finalize the stream so the settled prefix promotes into scrollback.
    setStatus(STREAM_PHASE.COMPLETED);
    syncStreamLog(defaultSession(), STREAM_ID);

    const finalized = streamEntries();
    expect(
      splitTranscriptEntries(
        finalized,
        streamSlice()?.finalizedFrontier ?? 0,
        STREAM_PHASE.COMPLETED,
      ).pending,
    ).toEqual([]);

    // A run's open phase is the shared stage fact, which the applier writes
    // from the same `stage.start` this test's `openStage` emitted; the header
    // reads it there rather than scanning for a phase row of its own.
    boundState.getOrCreateStreamState(STREAM_ID, AgentCategory.Workflow);
    boundState.updateStreamState(STREAM_ID, (prev) => ({
      ...prev,
      stage: { kind: 'phase', label: 'Draft sections' },
    }));
    const staticItems = appendItems(undefined, {
      childRosters: new Map([
        [
          PARENT_STREAM_ID,
          [
            {
              executionId: 'exec-1',
              childStreamId: STREAM_ID,
              identity: WORKFLOW_IDENTITY,
              agentName: 'draft-sections',
            },
          ],
        ],
      ]),
      parentStream: new Map([[STREAM_ID, PARENT_STREAM_ID]]),
      streams: streams.get(),
    });
    expect(staticItems.items.at(0)).toMatchObject({
      identityLine:
        'workflow script: draft-sections · parent: main · model: DeepSeek V4 Flash (Thinking)',
      kind: 'header',
    });

    const output = await renderStaticTranscript();
    // The phase header renders with its distinct diamond divider glyph, and
    // the call row carries its own per-status marker.
    expect(output).toContain('◆ Draft sections');
    expect(output).toContain('☑ Finished: Draft introduction');
    expect(output).toContain('DeepSeek V4 Flash (Thinking) · 12s · $0.002');
  });
});
