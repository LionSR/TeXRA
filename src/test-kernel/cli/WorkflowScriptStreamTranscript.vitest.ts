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
  buildStaticTranscriptItems,
  buildStaticTranscriptState,
  StaticConversationTranscript,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import {
  isFinalizedTranscriptRow,
  splitTranscriptEntries,
  transcriptRowHeadline,
} from '@cli/chat/tui/panes/transcriptEntries';
import {
  patchStream,
  resetCliState,
  streams,
  setStreamStatusInCliState,
} from '@cli/chat/tui/state/cliState';
import {
  bindChildStreamState,
  invalidateChildStreams,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { SessionState } from '@controllers/session/SessionState';
import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { transcriptText, type TranscriptRow } from '@shared/transcript';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { clearAllStreamStatusesForTest } from '@test/support/streamStatusTestUtils';
import { loadInk } from '@test/support/inkTestHarness.ts';
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

type StaticItems = ReturnType<typeof buildStaticTranscriptItems>['items'];

function appendItems(
  currentItems: StaticItems = [],
  overrides: Partial<Parameters<typeof buildStaticTranscriptItems>[0]> = {},
): StaticItems {
  return buildStaticTranscriptItems({
    currentItems,
    meta: SESSION_META,
    scrollbackStreamId: STREAM_ID,
    streams: streams.get(),
    ...overrides,
  }).items;
}

function staticEntries(items: StaticItems): readonly TranscriptRow[] {
  return items
    .filter((item) => item.kind === 'entry')
    .map((item) => item.entry);
}

function entryIds(items: StaticItems): string[] {
  return staticEntries(items).map((entry) => entry.id);
}

function entryTexts(items: StaticItems): string[] {
  return staticEntries(items).map(transcriptRowHeadline);
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
    syncStreamLog(sdkStreamId);

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
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID);

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
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.CANCELLED,
    });

    // This exercises both terminal-status finalization entry points:
    // syncStreamLog's settled-prefix promotion and the explicit
    // end-of-stream projection used by the controller.
    syncStreamLog(STREAM_ID, { forceFinal: true });

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
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID, { forceFinal: true });
    syncStreamLog(STREAM_ID);
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
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.CANCELLED,
    });
    syncStreamLog(STREAM_ID, { forceFinal: true });

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
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID, { forceFinal: true });
    syncStreamLog(STREAM_ID);
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
    syncStreamLog(STREAM_ID);
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
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.CANCELLED,
    });
    syncStreamLog(STREAM_ID, { forceFinal: true });

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
    syncStreamLog(STREAM_ID);

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
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.CANCELLED,
    });
    syncStreamLog(STREAM_ID);
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

  it('holds later settled rows behind pending declared-plan tasks', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    for (const [id, label] of [
      ['core', 'Audit core'],
      ['extension', 'Audit extension'],
      ['cli', 'Audit CLI'],
      ['desktop', 'Audit desktop'],
      ['scripts', 'Audit scripts'],
    ] as const) {
      runTrace.trace.emit({
        type: 'workflow.call',
        logId: `${id}-task`,
        call: {
          id,
          label,
          phase: 'Repository audit',
          status: 'planned',
        },
      });
    }
    syncStreamLog(STREAM_ID);

    runTrace.trace.info('Preparing repository audit', {
      messageType: MESSAGE_TYPES.DEFAULT,
    });
    appendLocalAssistantTranscript('Local audit checkpoint', STREAM_ID);
    const phase = runTrace.trace.openStage('Repository audit', {
      id: 'audit-phase',
      kind: 'phase',
    });
    syncStreamLog(STREAM_ID);

    const buildState = (repaintEpoch = 0) =>
      buildStaticTranscriptState({
        childStreamEntries: new Map(),
        maxRows: undefined,
        meta: SESSION_META,
        ownerKey: 'root',
        parentStream: new Map(),
        repaintEpoch,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
        width: 80,
      });
    const advance = (
      current: ReturnType<typeof buildStaticTranscriptState>,
    ): ReturnType<typeof buildStaticTranscriptState> =>
      advanceStaticTranscriptState(current, {
        childStreamEntries: new Map(),
        maxRows: undefined,
        meta: SESSION_META,
        ownerKey: 'root',
        parentStream: new Map(),
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
        width: 80,
      });

    let state = buildState();
    expect(entryIds(state.items)).toEqual([]);
    const initialOutput = await renderStaticTranscript();
    expect(initialOutput).not.toContain('Preparing repository audit');
    expect(initialOutput).not.toContain('Local audit checkpoint');
    expect(initialOutput).not.toContain('Repository audit');

    runTrace.trace.emit({
      type: 'workflow.call',
      logId: 'core-task',
      call: {
        id: 'core',
        label: 'Audit core',
        phase: 'Repository audit',
        status: 'completed',
        model: 'deepseekT',
      },
    });
    syncStreamLog(STREAM_ID);
    state = advance(state);
    expect(entryIds(state.items)).toEqual(['core-task']);
    const liveOutput = await renderStaticTranscript();
    expect(liveOutput).toContain('Finished: Audit core');
    expect(liveOutput).not.toContain('Preparing repository audit');
    expect(liveOutput).not.toContain('Local audit checkpoint');
    expect(liveOutput).not.toContain('Repository audit');

    phase.end('completed');
    syncStreamLog(STREAM_ID);
    state = advance(state);
    expect(entryIds(state.items)).toEqual(['core-task']);

    for (const id of ['extension', 'cli', 'desktop', 'scripts'] as const) {
      runTrace.trace.emit({
        type: 'workflow.call',
        logId: `${id}-task`,
        call: {
          id,
          label: `Audit ${id}`,
          phase: 'Repository audit',
          status: 'completed',
          model: 'deepseekT',
        },
      });
    }
    syncStreamLog(STREAM_ID);
    state = advance(state);

    const settledSlice = streamSlice();
    expect(
      settledSlice?.entries.findLast((row, index) =>
        isFinalizedTranscriptRow(row, index, settledSlice.finalizedFrontier),
      )?.id,
    ).toBe('audit-phase');

    const incrementalEntryIds = entryIds(state.items);
    expect(incrementalEntryIds).toEqual([
      expect.stringMatching(/.+/),
      expect.stringMatching(/^local:/),
      'audit-phase',
      'core-task',
      'extension-task',
      'cli-task',
      'desktop-task',
      'scripts-task',
    ]);
    expect(entryIds(appendItems([]))).toEqual(incrementalEntryIds);
    const coldOutput = await renderStaticTranscript();
    expectOutputOrder(coldOutput, [
      'Preparing repository audit',
      'Local audit checkpoint',
      '◆ Repository audit',
      'Finished: Audit core',
      'Finished: Audit extension',
      'Finished: Audit cli',
      'Finished: Audit desktop',
      'Finished: Audit scripts',
    ]);
  });

  it('keeps a dynamic phase header above tasks introduced inside it', async () => {
    const runTrace = openRunTrace(STREAM_ID);
    const phase = runTrace.trace.openStage('Dynamic audit', {
      id: 'dynamic-phase',
      kind: 'phase',
    });
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID);
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
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID);
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
    syncStreamLog(STREAM_ID);

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
    syncStreamLog(STREAM_ID);
    incrementalItems = appendItems(incrementalItems);
    const coldItems = appendItems();
    expect(staticEntries(incrementalItems).map((entry) => entry.kind)).toEqual([
      'fileList',
      'tool',
    ]);
    expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
    const output = await renderStaticTranscript();
    expect(output.indexOf('[image] /private/tmp/loaded.png')).toBeLessThan(
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
    syncStreamLog(STREAM_ID);

    const incrementalItems = appendItems();
    round.end('completed');
    syncStreamLog(STREAM_ID);
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
    syncStreamLog(STREAM_ID);
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

    syncStreamLog(STREAM_ID);

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
    setStreamStatusInCliState({
      streamId: STREAM_ID,
      status: STREAM_PHASE.COMPLETED,
    });
    syncStreamLog(STREAM_ID);

    const finalized = streamEntries();
    expect(
      splitTranscriptEntries(
        finalized,
        streamSlice()?.finalizedFrontier ?? 0,
        STREAM_PHASE.COMPLETED,
      ).pending,
    ).toEqual([]);

    const staticItems = appendItems([], {
      childStreamEntries: new Map([
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
    expect(staticItems.at(0)).toMatchObject({
      identityLine:
        'workflow script: draft-sections · Draft sections · parent: main · model: DeepSeek V4 Flash (Thinking)',
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
