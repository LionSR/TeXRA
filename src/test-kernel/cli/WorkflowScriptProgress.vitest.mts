import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@test/support/defaultSessionTestSetup';

import { createRunTrace } from '@transcript';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  appendStaticTranscriptItems,
  StaticConversationTranscript,
} from '@cli/chat/tui/panes/StaticConversationTranscript';
import { splitTranscriptEntries } from '@cli/chat/tui/panes/transcriptEntries';
import {
  patchStream,
  removeStream,
  resetCliState,
  streams,
  type WorkflowScriptProgressFact,
} from '@cli/chat/tui/state/cliState';
import { attachTuiRunFactSubscription } from '@cli/chat/tui/state/subscribeRuntimeHost';
import { syncStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { TOOL_USE_STATUS, type StreamTabId } from '@shared/schemas';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';

const STREAM_ID = 'workflow-script-progress' as StreamTabId;
const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);
const SESSION_META = {
  agent: 'research',
  category: 'toolUse',
  model: 'deepseekT',
  modelSource: 'builtin-default',
  cwd: '/tmp/project',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  canDelegate: true,
  transcriptMode: 'persistent',
  version: '0.39.6',
} as const;

const FACTS: readonly WorkflowScriptProgressFact[] = [
  {
    type: 'phase',
    id: 'workflow-tool:phase:draft-phase',
    stageId: 'draft-phase',
    label: 'Draft sections',
  },
  {
    type: 'log',
    id: 'workflow-tool:log:0',
    level: 'info',
    message: 'Running: introduction',
    phaseId: 'draft-phase',
  },
  {
    type: 'log',
    id: 'workflow-tool:log:1',
    level: 'info',
    message: 'Finished: introduction ($0.002 total)',
    phaseId: 'draft-phase',
  },
];

async function renderStaticTranscript(): Promise<string> {
  const ink = (await import(cliRequire.resolve('ink'))) as any;
  const React = ((await import(cliRequire.resolve('react'))) as any).default;
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
  await defaultSession().transcripts.clear();
  patchStream(STREAM_ID, (slice) => ({ ...slice }));
});

afterEach(() => {
  resetCliState();
});

describe('CLI workflow-script progress', () => {
  it('renders the successful terminal state and workflow result', async () => {
    const events = new SessionEventHub();
    const detachTui = attachTuiRunFactSubscription(events);
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    const detachHub = runTrace.trace.subscribe((event) =>
      events.emit({ scope: 'run', streamId: STREAM_ID, event }),
    );

    try {
      runTrace.trace.toolStart(
        {
          logId: 'workflow-tool',
          toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
          input: { agent: 'writer', script: '...' },
        },
        { stageId: 'round-1' },
      );
      let staticItems = appendStaticTranscriptItems({
        currentItems: [],
        streams: streams.get(),
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
      });
      expect(staticItems.map((item) => item.id)).toEqual([
        'session-header',
        'workflow-tool',
      ]);
      const startedEntries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(splitTranscriptEntries(startedEntries, undefined).pending).toEqual(
        [],
      );

      runTrace.trace.info('Preparing shared inputs', { stageId: 'round-1' });
      const phase = runTrace.trace.openStage('Draft sections', {
        id: 'draft-phase',
        kind: 'phase',
        parentId: 'round-1',
      });
      runTrace.trace.info('Running: introduction', { stageId: phase.id });
      runTrace.trace.info('Finished: introduction ($0.002 total)', {
        stageId: phase.id,
      });
      runTrace.trace.info('unrelated parent log', { stageId: 'other-stage' });

      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        streams: streams.get(),
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
      });
      expect(staticItems.map((item) => item.id)).toEqual([
        'session-header',
        'workflow-tool',
        'workflow-tool:log:0',
        'workflow-tool:phase:draft-phase',
        'workflow-tool:log:1',
        'workflow-tool:log:2',
      ]);

      phase.end('completed');
      runTrace.trace.toolEnd(
        {
          logId: 'workflow-tool',
          status: 'completed',
          result: {
            toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
            input: { agent: 'writer' },
            summary: "Completed workflow script 'draft' (1 agent call)",
            output: 'assembled draft',
          },
        },
        { stageId: 'round-1' },
      );
      runTrace.trace.info('after completion', { stageId: 'round-1' });

      const entry = streams
        .get()
        .get(STREAM_ID)
        ?.entries.find((candidate) => candidate.id === 'workflow-tool');
      expect(entry?.role).toBe('tool');
      if (entry?.role !== 'tool') throw new Error('missing workflow tool row');
      expect(entry.workflowScriptFacts).toEqual([
        {
          type: 'log',
          id: 'workflow-tool:log:0',
          level: 'info',
          message: 'Preparing shared inputs',
        },
        {
          type: 'phase',
          id: 'workflow-tool:phase:draft-phase',
          stageId: 'draft-phase',
          label: 'Draft sections',
        },
        {
          type: 'log',
          id: 'workflow-tool:log:1',
          level: 'info',
          message: 'Running: introduction',
          phaseId: 'draft-phase',
        },
        {
          type: 'log',
          id: 'workflow-tool:log:2',
          level: 'info',
          message: 'Finished: introduction ($0.002 total)',
          phaseId: 'draft-phase',
        },
      ]);
      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        streams: streams.get(),
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
      });
      expect(staticItems.at(-1)).toMatchObject({
        id: 'workflow-tool:completion',
        kind: 'workflowScriptCompletion',
      });
      const output = await renderStaticTranscript();
      expect(output).toContain('Workflow script completed');
      expect(output).toContain('assembled draft');
    } finally {
      detachHub();
      runTrace.dispose();
      detachTui();
    }
  });

  it('keeps workflow facts behind a preceding in-progress tool', () => {
    const events = new SessionEventHub();
    const detachTui = attachTuiRunFactSubscription(events);
    const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
    const detachHub = runTrace.trace.subscribe((event) =>
      events.emit({ scope: 'run', streamId: STREAM_ID, event }),
    );

    try {
      runTrace.trace.toolStart(
        {
          logId: 'preceding-tool',
          toolName: 'bash',
          input: { command: 'pwd' },
        },
        { stageId: 'round-1' },
      );
      runTrace.trace.toolStart(
        {
          logId: 'workflow-tool',
          toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
          input: { agent: 'writer', script: '...' },
        },
        { stageId: 'round-1' },
      );
      runTrace.trace.info('Preparing shared inputs', { stageId: 'round-1' });

      let entries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(entries.map((entry) => [entry.id, entry.finalized])).toEqual([
        ['preceding-tool', false],
        ['workflow-tool', false],
      ]);
      let staticItems = appendStaticTranscriptItems({
        currentItems: [],
        streams: streams.get(),
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
      });
      expect(staticItems.map((item) => item.id)).toEqual(['session-header']);

      runTrace.trace.toolEnd(
        {
          logId: 'preceding-tool',
          status: 'completed',
          result: {
            toolName: 'bash',
            input: { command: 'pwd' },
            output: '/tmp/project',
          },
        },
        { stageId: 'round-1' },
      );
      syncStreamLog(STREAM_ID);

      entries = streams.get().get(STREAM_ID)?.entries ?? [];
      expect(entries.map((entry) => [entry.id, entry.finalized])).toEqual([
        ['preceding-tool', true],
        ['workflow-tool', true],
      ]);
      staticItems = appendStaticTranscriptItems({
        currentItems: staticItems,
        streams: streams.get(),
        meta: SESSION_META,
        scrollbackStreamId: STREAM_ID,
      });
      expect(staticItems.map((item) => item.id)).toEqual([
        'session-header',
        'preceding-tool',
        'workflow-tool',
        'workflow-tool:log:0',
      ]);
    } finally {
      detachHub();
      runTrace.dispose();
      detachTui();
    }
  });

  it.each([
    [
      'failed',
      'failed',
      { error: 'Writer agent failed' },
      'Writer agent failed',
    ],
    [
      'cancelled',
      'failed',
      { output: 'Tool execution cancelled by user.' },
      'Tool execution cancelled by user.',
    ],
    [
      'completed error result',
      'completed',
      { error: 'Workflow validation failed', isError: true },
      'Workflow validation failed',
    ],
  ] as const)(
    'renders a terminal failure for a %s workflow',
    async (_caseName, status, result, expectedMessage) => {
      const events = new SessionEventHub();
      const detachTui = attachTuiRunFactSubscription(events);
      const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
      const detachHub = runTrace.trace.subscribe((event) =>
        events.emit({ scope: 'run', streamId: STREAM_ID, event }),
      );

      try {
        runTrace.trace.toolStart(
          {
            logId: 'workflow-tool',
            toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
            input: { agent: 'writer', script: '...' },
          },
          { stageId: 'round-1' },
        );
        runTrace.trace.toolEnd(
          {
            logId: 'workflow-tool',
            status,
            result: {
              toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
              input: { agent: 'writer' },
              isError: true,
              ...result,
            },
          },
          { stageId: 'round-1' },
        );

        const entry = streams
          .get()
          .get(STREAM_ID)
          ?.entries.find((candidate) => candidate.id === 'workflow-tool');
        expect(entry).toMatchObject({
          finalized: true,
          role: 'tool',
          workflowScriptOutcome: 'failed',
        });
        if (entry?.role !== 'tool')
          throw new Error('missing workflow tool row');
        expect(entry.toolUse.status).toBe(TOOL_USE_STATUS.FAILED);
        expect(entry.toolUse.isError).toBe(true);

        const output = await renderStaticTranscript();
        expect(output).toContain('Workflow script failed');
        expect(output).toContain(expectedMessage);
      } finally {
        detachHub();
        runTrace.dispose();
        detachTui();
      }
    },
  );

  it.each(['remove', 'reset'] as const)(
    '%s retires workflow ownership before late events arrive',
    (retirement) => {
      const events = new SessionEventHub();
      const detachTui = attachTuiRunFactSubscription(events);
      const runTrace = createRunTrace(STREAM_ID, defaultSession().transcripts);
      const detachHub = runTrace.trace.subscribe((event) =>
        events.emit({ scope: 'run', streamId: STREAM_ID, event }),
      );

      try {
        runTrace.trace.toolStart(
          {
            logId: 'workflow-tool',
            toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
            input: { agent: 'writer', script: '...' },
          },
          { stageId: 'round-1' },
        );
        expect(streams.get().get(STREAM_ID)?.activeWorkflowScript?.logId).toBe(
          'workflow-tool',
        );

        if (retirement === 'remove') removeStream(STREAM_ID);
        else resetCliState();

        events.emit({
          scope: 'run',
          streamId: STREAM_ID,
          event: {
            type: 'tool.start',
            logId: 'late-workflow-tool',
            toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
            input: { agent: 'writer', script: '...' },
            stageId: 'round-1',
          },
        });
        events.emit({
          scope: 'run',
          streamId: STREAM_ID,
          event: {
            type: 'stage.start',
            id: 'late-phase',
            kind: 'phase',
            label: 'Late phase',
            parentId: 'round-1',
          },
        });
        events.emit({
          scope: 'run',
          streamId: STREAM_ID,
          event: {
            type: 'log',
            level: 'info',
            message: 'late workflow log',
            stageId: 'round-1',
          },
        });
        events.emit({
          scope: 'run',
          streamId: STREAM_ID,
          event: {
            type: 'tool.end',
            logId: 'workflow-tool',
            status: 'failed',
            result: { error: 'late failure' },
            stageId: 'round-1',
          },
        });

        expect(streams.get().has(STREAM_ID)).toBe(false);
      } finally {
        detachHub();
        runTrace.dispose();
        detachTui();
      }
    },
  );

  it('renders dim Static facts verbatim without interpreting child costs', async () => {
    patchStream(STREAM_ID, (slice) => ({
      ...slice,
      entries: [
        {
          finalized: true,
          id: 'workflow-tool',
          role: 'tool',
          text: '',
          toolUse: {
            parsed: {},
            toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
            errorText: '',
            outputText: '',
            userInstructionText: '',
            input: { agent: 'writer' },
            isError: false,
            isUserFeedback: false,
            headerSummary: '',
            status: TOOL_USE_STATUS.IN_PROGRESS,
          },
          workflowScriptFacts: FACTS,
        },
      ],
    }));
    const output = await renderStaticTranscript();

    expect(output).toContain('⎿ Draft sections');
    expect(output).toContain('Running: introduction');
    expect(output).toContain('Finished: introduction ($0.002 total)');
  });
});
