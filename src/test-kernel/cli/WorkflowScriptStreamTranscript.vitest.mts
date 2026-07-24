// A detached delegate_workflow_script run owns a child stream. Its phases and
// typed task records render through the focused-child viewport, while the
// workflow-specific header identifies the kind of child execution.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@test/support/defaultSessionTestSetup';
import { defaultSession } from '@agent/runtime/SessionHandle';

import {
  StaticConversationTranscript,
  appendStaticTranscriptItems,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import {
  orderedStaticTranscriptEntries,
  splitTranscriptEntries,
} from '@cli/chat/tui/panes/transcriptEntries';
import {
  patchStream,
  resetCliState,
  streams,
  type ConversationEntry,
} from '@cli/chat/tui/state/cliState';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { createTranscriptPrintRequest } from '@cli/chat/tui/state/transcriptLines';
import { projectStreamTranscript } from '@cli/chat/tui/state/transcriptProjection';
import {
  MESSAGE_TYPES,
  STREAM_PHASE,
  TOOL_USE_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { clearAllStreamStatusesForTest } from '@test/helpers/streamStatusTestUtils';
import { loadInk } from '@test/support/inkTestHarness.mts';
import { createRunTrace } from '@transcript';

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

beforeEach(async () => {
  resetCliState();
  clearAllStreamStatusesForTest(defaultSession().status);
  await defaultSession().transcripts.clear();
  patchStream(STREAM_ID, (slice) => ({ ...slice, model: 'deepseekT' }));
});

afterEach(() => {
  resetCliState();
});

describe('CLI workflow-script child-stream transcript', () => {
  it('keeps planned task rows live until their terminal state is printable', () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      for (const [id, label] of [
        ['core', 'Audit core'],
        ['extension', 'Audit extension'],
      ] as const) {
        runTrace.trace.emit({
          type: 'workflow.task',
          logId: `${id}-task`,
          task: { id, label, status: 'planned' },
        });
      }
      syncStreamLog(STREAM_ID);

      const plannedEntries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(plannedEntries).toMatchObject([
        {
          id: 'core-task',
          role: 'workflowTask',
          finalized: false,
          task: { id: 'core', status: 'planned' },
        },
        {
          id: 'extension-task',
          role: 'workflowTask',
          finalized: false,
          task: { id: 'extension', status: 'planned' },
        },
      ]);

      const plannedItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(plannedItems.filter((item) => item.kind === 'entry')).toHaveLength(
        0,
      );

      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'core-task',
        task: {
          id: 'core',
          label: 'Audit core',
          status: 'completed',
          model: 'deepseekT',
        },
      });
      syncStreamLog(STREAM_ID);

      const updatedEntries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(updatedEntries).toMatchObject([
        {
          id: 'core-task',
          finalized: true,
          task: { status: 'completed' },
          text: 'Finished: Audit core · deepseekT',
        },
        {
          id: 'extension-task',
          finalized: false,
          task: { status: 'planned' },
          text: 'Planned: Audit extension',
        },
      ]);

      const updatedItems = appendStaticTranscriptItems({
        currentItems: plannedItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(
        updatedItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.text),
      ).toEqual(['Finished: Audit core · deepseekT']);
    } finally {
      runTrace.dispose();
    }
  });

  it('keeps a running task replaceable when cancellation precedes bridge cleanup', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'cancelled-running-task',
        task: {
          id: 'cancelled-running',
          label: 'Audit cancellation',
          status: 'running',
        },
      });
      patchStream(STREAM_ID, (slice) => ({
        ...slice,
        status: STREAM_PHASE.CANCELLED,
      }));

      // This exercises both terminal-status finalization entry points:
      // syncStreamLog's settled-prefix promotion and the explicit
      // end-of-stream projection used by the controller.
      projectStreamTranscript(STREAM_ID, { finalize: true });

      expect(streams.get().get(STREAM_ID)?.entries.at(0)).toMatchObject({
        finalized: false,
        text: 'Running: Audit cancellation',
        task: { status: 'running' },
      });
      let staticItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(staticItems.filter((item) => item.kind === 'entry')).toEqual([]);

      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'cancelled-running-task',
        task: {
          id: 'cancelled-running',
          label: 'Audit cancellation',
          status: 'failed',
          error: 'The workflow ended before this task completed.',
        },
      });
      syncStreamLog(STREAM_ID);

      const settledEntries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(settledEntries).toHaveLength(1);
      expect(settledEntries).toMatchObject([
        {
          id: 'cancelled-running-task',
          finalized: true,
          task: {
            id: 'cancelled-running',
            status: 'failed',
          },
        },
      ]);
      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      projectStreamTranscript(STREAM_ID, { finalize: true });
      syncStreamLog(STREAM_ID);
      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(
        staticItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.text),
      ).toEqual([
        'Failed: Audit cancellation — The workflow ended before this task completed.',
      ]);
      expect(
        staticItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id),
      ).toEqual(['cancelled-running-task']);
      const output = await renderStaticTranscript();
      expect(output).toContain('Failed: Audit cancellation');
      expect(output).not.toContain('Running: Audit cancellation');
    } finally {
      runTrace.dispose();
    }
  });

  it('keeps a cold-rebuilt planned task replaceable until not-reached cleanup settles it', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'cancelled-planned-task',
        task: {
          id: 'cancelled-planned',
          label: 'Audit later',
          status: 'planned',
        },
      });

      // Rebuild CLI state from the durable log after cancellation, before the
      // bridge has projected its not-reached terminal update.
      resetCliState();
      patchStream(STREAM_ID, (slice) => ({
        ...slice,
        model: 'deepseekT',
        status: STREAM_PHASE.CANCELLED,
      }));
      projectStreamTranscript(STREAM_ID, { finalize: true });

      expect(streams.get().get(STREAM_ID)?.entries.at(0)).toMatchObject({
        finalized: false,
        text: 'Planned: Audit later',
        task: { status: 'planned' },
      });
      let staticItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(staticItems.filter((item) => item.kind === 'entry')).toEqual([]);

      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'cancelled-planned-task',
        task: {
          id: 'cancelled-planned',
          label: 'Audit later',
          status: 'skipped',
          reason: 'not-reached',
        },
      });
      syncStreamLog(STREAM_ID, { forceFull: true });

      const settledEntries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(settledEntries).toHaveLength(1);
      expect(settledEntries).toMatchObject([
        {
          id: 'cancelled-planned-task',
          finalized: true,
          task: {
            id: 'cancelled-planned',
            status: 'skipped',
            reason: 'not-reached',
          },
        },
      ]);
      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      projectStreamTranscript(STREAM_ID, { finalize: true });
      syncStreamLog(STREAM_ID, { forceFull: true });
      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(
        staticItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.text),
      ).toEqual([
        'Skipped: Audit later — The workflow ended before this task was reached.',
      ]);
      expect(
        staticItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id),
      ).toEqual(['cancelled-planned-task']);
      const output = await renderStaticTranscript();
      // The skipped marker distinguishes the row from a finished or failed one.
      expect(output).toContain('⊘ Skipped: Audit later');
      expect(output).toContain('The workflow ended before this task was');
      expect(output).not.toContain('Planned: Audit later');
    } finally {
      runTrace.dispose();
    }
  });

  it('keeps mixed cancelled settlement order identical live and cold', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      const phase = runTrace.trace.openStage('Cancellation audit', {
        id: 'cancel-phase',
        kind: 'phase',
      });
      appendLocalAssistantTranscript(
        'Local cancellation checkpoint',
        STREAM_ID,
      );
      syncStreamLog(STREAM_ID);
      const entryIds = (
        items: ReturnType<typeof appendStaticTranscriptItems>,
      ): string[] =>
        items
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id);
      let liveItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
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
        type: 'workflow.task',
        logId: 'cancel-plan',
        stageId: phase.id,
        task: {
          id: 'cancel-plan',
          label: 'Audit after cancellation',
          phase: 'Cancellation audit',
          status: 'planned',
        },
      });

      runTrace.trace.emit({
        type: 'status',
        streamId: STREAM_ID,
        phase: STREAM_PHASE.CANCELLED,
        cause: STREAM_TRANSITION_CAUSE.USER_STOP,
      });
      patchStream(STREAM_ID, (slice) => ({
        ...slice,
        status: STREAM_PHASE.CANCELLED,
      }));
      projectStreamTranscript(STREAM_ID, { finalize: true });

      liveItems = appendStaticTranscriptItems({
        currentItems: liveItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
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

      const syntheticEntry = streams
        .get()
        .get(STREAM_ID)
        ?.entries.find((entry) => entry.synthetic);
      expect(syntheticEntry).toBeDefined();
      expect(
        defaultSession()
          .transcripts.get(STREAM_ID)
          ?.getRange(0)
          .find((entry) => entry.id === response.id),
      ).toMatchObject({
        settlementSeqNo: 2,
        text: 'Partial cancellation answer',
      });
      expect(
        defaultSession()
          .transcripts.get(STREAM_ID)
          ?.getRange(0)
          .find((entry) => entry.id === 'cancel-tool'),
      ).toMatchObject({
        settlementSeqNo: 3,
        data: {
          status: 'failed',
          error: 'The stream ended before this tool completed.',
        },
      });
      expect(
        defaultSession()
          .transcripts.get(STREAM_ID)
          ?.getRange(0)
          .find((entry) => entry.id === 'cancel-plan'),
      ).not.toHaveProperty('settlementSeqNo');

      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'cancel-plan',
        stageId: phase.id,
        task: {
          id: 'cancel-plan',
          label: 'Audit after cancellation',
          phase: 'Cancellation audit',
          status: 'skipped',
          reason: 'not-reached',
        },
      });
      phase.end('cancelled');
      syncStreamLog(STREAM_ID);

      liveItems = appendStaticTranscriptItems({
        currentItems: liveItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
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
        model: 'deepseekT',
        status: STREAM_PHASE.CANCELLED,
        entries: syntheticEntry ? [syntheticEntry] : [],
      }));
      syncStreamLog(STREAM_ID, { forceFull: true });
      const coldItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });

      expect(entryIds(coldItems)).toEqual(entryIds(liveItems));
      const coldOutput = await renderStaticTranscript();
      expect(coldOutput).toBe(liveOutput);
      expect(coldOutput.indexOf('◆ Cancellation audit')).toBeLessThan(
        coldOutput.indexOf('Local cancellation checkpoint'),
      );
      expect(coldOutput.indexOf('Local cancellation checkpoint')).toBeLessThan(
        coldOutput.indexOf('Partial cancellation answer'),
      );
      expect(coldOutput.indexOf('Partial cancellation answer')).toBeLessThan(
        coldOutput.indexOf('The stream ended before this tool completed.'),
      );
      expect(
        coldOutput.indexOf('The stream ended before this tool completed.'),
      ).toBeLessThan(coldOutput.indexOf('Skipped: Audit after cancellation'));
    } finally {
      runTrace.dispose();
    }
  });

  it('keeps declared-plan phase-task and print chronology identical live and cold', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      for (const [id, label] of [
        ['core', 'Audit core'],
        ['extension', 'Audit extension'],
        ['cli', 'Audit CLI'],
        ['desktop', 'Audit desktop'],
        ['scripts', 'Audit scripts'],
      ] as const) {
        runTrace.trace.emit({
          type: 'workflow.task',
          logId: `${id}-task`,
          task: {
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

      let incrementalItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(
        incrementalItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id),
      ).toEqual([
        expect.stringMatching(/.+/),
        expect.stringMatching(/^local:/),
        'audit-phase',
      ]);
      const initialOutput = await renderStaticTranscript();
      expect(initialOutput.indexOf('Preparing repository audit')).toBeLessThan(
        initialOutput.indexOf('Local audit checkpoint'),
      );
      expect(initialOutput.indexOf('Local audit checkpoint')).toBeLessThan(
        initialOutput.indexOf('◆ Repository audit'),
      );

      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'core-task',
        task: {
          id: 'core',
          label: 'Audit core',
          phase: 'Repository audit',
          status: 'completed',
          model: 'deepseekT',
        },
      });
      syncStreamLog(STREAM_ID);
      incrementalItems = appendStaticTranscriptItems({
        currentItems: incrementalItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(
        incrementalItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id),
      ).toEqual([
        expect.stringMatching(/.+/),
        expect.stringMatching(/^local:/),
        'audit-phase',
        'core-task',
      ]);
      const liveOutput = await renderStaticTranscript();
      expect(liveOutput.indexOf('Preparing repository audit')).toBeLessThan(
        liveOutput.indexOf('Local audit checkpoint'),
      );
      expect(liveOutput.indexOf('Local audit checkpoint')).toBeLessThan(
        liveOutput.indexOf('◆ Repository audit'),
      );
      expect(liveOutput.indexOf('◆ Repository audit')).toBeLessThan(
        liveOutput.indexOf('Finished: Audit core'),
      );

      phase.end('completed');
      syncStreamLog(STREAM_ID);
      incrementalItems = appendStaticTranscriptItems({
        currentItems: incrementalItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });

      const settledSlice = streams.get().get(STREAM_ID);
      expect(
        settledSlice?.entries.findLast((entry) => entry.finalized)?.id,
      ).toBe('audit-phase');
      const printAnchor = settledSlice
        ? orderedStaticTranscriptEntries(
            settledSlice.entries,
            settledSlice.status,
          ).at(-1)?.id
        : undefined;
      expect(printAnchor).toBe('core-task');
      const printRequest = createTranscriptPrintRequest({
        afterEntryId: printAnchor,
        id: 'printed-transcript:declared-plan',
        ownerKey: 'root',
        slice: settledSlice,
        title: 'repository audit',
      });
      incrementalItems = appendStaticTranscriptItems({
        currentItems: incrementalItems,
        meta: SESSION_META,
        printRequests: [printRequest],
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });

      const coldItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        printRequests: [printRequest],
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      const entryIds = (
        items: ReturnType<typeof appendStaticTranscriptItems>,
      ): string[] =>
        items
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id);

      const incrementalEntryIds = entryIds(incrementalItems);
      expect(incrementalEntryIds.at(-2)).toBe('audit-phase');
      expect(incrementalEntryIds.at(-1)).toBe('core-task');
      expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
      expect(incrementalItems.map((item) => item.id).slice(-3)).toEqual([
        'audit-phase',
        'core-task',
        'printed-transcript:declared-plan',
      ]);
      expect(coldItems.map((item) => item.id)).toEqual(
        incrementalItems.map((item) => item.id),
      );
      const coldOutput = await renderStaticTranscript();
      expect(coldOutput.indexOf('Preparing repository audit')).toBeLessThan(
        coldOutput.indexOf('Local audit checkpoint'),
      );
      expect(coldOutput.indexOf('Local audit checkpoint')).toBeLessThan(
        coldOutput.indexOf('◆ Repository audit'),
      );
      expect(coldOutput.indexOf('◆ Repository audit')).toBeLessThan(
        coldOutput.indexOf('Finished: Audit core'),
      );
    } finally {
      runTrace.dispose();
    }
  });

  it('keeps a dynamic phase header above tasks introduced inside it', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      const phase = runTrace.trace.openStage('Dynamic audit', {
        id: 'dynamic-phase',
        kind: 'phase',
      });
      syncStreamLog(STREAM_ID);

      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'dynamic-task',
        stageId: phase.id,
        task: {
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
        type: 'workflow.task',
        logId: 'dynamic-task',
        stageId: phase.id,
        task: {
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
    } finally {
      runTrace.dispose();
    }
  });

  it('orders synthetic rows against legacy source sequence coordinates', async () => {
    const beforeLoad = {
      id: 'local-before-load',
      role: 'assistant',
      text: 'Before legacy load',
      finalized: true,
      synthetic: true,
      syntheticKind: 'local',
      syntheticAfterSeq: 0,
      syntheticAfterSettlementSeqNo: 0,
    } satisfies ConversationEntry;
    const legacyA = {
      id: 'legacy-a',
      sourceSeqNo: 1,
      role: 'assistant',
      text: 'Legacy A',
      finalized: true,
    } satisfies ConversationEntry;
    const legacyB = {
      id: 'legacy-b',
      sourceSeqNo: 2,
      role: 'assistant',
      text: 'Legacy B',
      finalized: true,
    } satisfies ConversationEntry;
    const afterLoad = {
      id: 'local-after-load',
      role: 'assistant',
      text: 'After legacy load',
      finalized: true,
      synthetic: true,
      syntheticKind: 'local',
      syntheticAfterSeq: 2,
      syntheticAfterSettlementSeqNo: 2,
    } satisfies ConversationEntry;

    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [beforeLoad],
    }));
    let incrementalItems = appendStaticTranscriptItems({
      currentItems: [],
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      streams: streams.get(),
    });
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [beforeLoad, legacyA, legacyB],
    }));
    incrementalItems = appendStaticTranscriptItems({
      currentItems: incrementalItems,
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      streams: streams.get(),
    });
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [beforeLoad, legacyA, legacyB, afterLoad],
    }));
    incrementalItems = appendStaticTranscriptItems({
      currentItems: incrementalItems,
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      streams: streams.get(),
    });
    const coldItems = appendStaticTranscriptItems({
      currentItems: [],
      meta: SESSION_META,
      scrollbackStreamId: STREAM_ID,
      streams: streams.get(),
    });
    const entryIds = (
      items: ReturnType<typeof appendStaticTranscriptItems>,
    ): string[] =>
      items
        .filter((item) => item.kind === 'entry')
        .map((item) => item.entry.id);

    expect(entryIds(incrementalItems)).toEqual([
      'local-before-load',
      'legacy-a',
      'legacy-b',
      'local-after-load',
    ]);
    expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
    const output = await renderStaticTranscript();
    expect(output.indexOf('Before legacy load')).toBeLessThan(
      output.indexOf('Legacy A'),
    );
    expect(output.indexOf('Legacy A')).toBeLessThan(output.indexOf('Legacy B'));
    expect(output.indexOf('Legacy B')).toBeLessThan(
      output.indexOf('After legacy load'),
    );
  });

  it('settles a repeated tool lifecycle at its terminal update', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
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

      let incrementalItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(
        incrementalItems
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id),
      ).not.toContain('audit-tool');

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
      incrementalItems = appendStaticTranscriptItems({
        currentItems: incrementalItems,
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      const coldItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      const entryIds = (
        items: ReturnType<typeof appendStaticTranscriptItems>,
      ): string[] =>
        items
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.id);

      expect(entryIds(incrementalItems).at(-1)).toBe('audit-tool');
      expect(entryIds(coldItems)).toEqual(entryIds(incrementalItems));
      const output = await renderStaticTranscript();
      expect(output.indexOf('Tool checkpoint recorded')).toBeLessThan(
        output.indexOf('pwd'),
      );
    } finally {
      runTrace.dispose();
    }
  });

  it('keeps an immutable round header ahead of its later log rows', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      const round = runTrace.trace.openStage('Round one', {
        id: 'round-one',
        kind: 'round',
      });
      runTrace.trace.info('Round work completed', {
        messageType: MESSAGE_TYPES.DEFAULT,
      });
      syncStreamLog(STREAM_ID);

      const incrementalItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      round.end('completed');
      syncStreamLog(STREAM_ID);
      const coldItems = appendStaticTranscriptItems({
        currentItems: [],
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      const entryTexts = (
        items: ReturnType<typeof appendStaticTranscriptItems>,
      ): string[] =>
        items
          .filter((item) => item.kind === 'entry')
          .map((item) => item.entry.text);

      expect(entryTexts(incrementalItems)).toEqual([
        'Round one',
        'Round work completed',
      ]);
      expect(entryTexts(coldItems)).toEqual(entryTexts(incrementalItems));
      const output = await renderStaticTranscript();
      expect(output.indexOf('Round one')).toBeLessThan(
        output.indexOf('Round work completed'),
      );
    } finally {
      runTrace.dispose();
    }
  });

  it('updates one visible task record from planned to completed', async () => {
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    try {
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'introduction-task',
        task: {
          id: 'introduction',
          label: 'Draft introduction',
          phase: 'Draft sections',
          status: 'planned',
        },
      });
      syncStreamLog(STREAM_ID);
      expect(
        streams
          .get()
          .get(STREAM_ID)
          ?.entries.find((entry) => entry.id === 'introduction-task')?.text,
      ).toBe('Planned: Draft introduction');

      const phase = runTrace.trace.openStage('Draft sections', {
        id: 'draft-phase',
        kind: 'phase',
      });
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'introduction-task',
        stageId: phase.id,
        task: {
          id: 'introduction',
          label: 'Draft introduction',
          phase: 'Draft sections',
          status: 'running',
        },
      });
      runTrace.trace.emit({
        type: 'workflow.task',
        logId: 'introduction-task',
        stageId: phase.id,
        task: {
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

      const entries = streams.get().get(STREAM_ID)?.entries ?? [];
      const texts = entries.map((entry) => entry.text);
      // The phase group row and the task's current state both surface.
      expect(texts).toContain('Draft sections');
      expect(texts).toContain(
        'Finished: Draft introduction · deepseekT · 12s · $0.002 total',
      );
      expect(
        entries.filter((entry) => entry.id === 'introduction-task'),
      ).toHaveLength(1);

      // The phase group is a distinct `role: 'phase'` header, not a plain
      // assistant row, so the CLI can render it as a divider between phases.
      const phaseEntry = entries.find(
        (entry) => entry.text === 'Draft sections',
      );
      expect(phaseEntry).toMatchObject({
        role: 'phase',
        phaseLabel: 'Draft sections',
        finalized: true,
      });

      // Finalize the stream so the settled prefix promotes into scrollback.
      patchStream(STREAM_ID, (slice) => ({
        ...slice,
        status: STREAM_PHASE.COMPLETED,
      }));
      syncStreamLog(STREAM_ID);

      const finalized = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(
        splitTranscriptEntries(finalized, STREAM_PHASE.COMPLETED).pending,
      ).toEqual([]);

      const staticItems = appendStaticTranscriptItems({
        childStreamEntries: new Map([
          [
            STREAM_ID,
            {
              kind: 'live' as const,
              active: true,
              parent: {
                kind: 'roster' as const,
                retained: { streamId: PARENT_STREAM_ID, order: 1 },
              },
              summary: {
                agentName: 'draft-sections',
                executionId: 'exec-1',
                kind: 'subagent' as const,
                toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
              },
            },
          ],
        ]),
        currentItems: [],
        meta: SESSION_META,
        parentStream: new Map([[STREAM_ID, PARENT_STREAM_ID]]),
        scrollbackStreamId: STREAM_ID,
        streams: streams.get(),
      });
      expect(staticItems.at(0)).toMatchObject({
        identityLine:
          'workflow script: draft-sections · parent: main · model: deepseekT',
        kind: 'header',
      });

      const output = await renderStaticTranscript();
      // The phase header renders with its distinct diamond divider glyph, and
      // the task row carries its own per-status marker.
      expect(output).toContain('◆ Draft sections');
      expect(output).toContain('☑ Finished: Draft introduction');
      expect(output).toContain('deepseekT · 12s · $0.002 total');
    } finally {
      runTrace.dispose();
    }
  });
});
