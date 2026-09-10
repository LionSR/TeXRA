import { it as effectIt } from '@effect/vitest';
/** Completed conversation reads and task reads through the archive facade. */
import { Effect, Stream, SubscriptionRef } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchMocks = vi.hoisted(() => ({
  acquireResumedExecutionLease: vi.fn(),
  buildVars: vi.fn(),
  createHandler: vi.fn(),
  hasPersistedParent: vi.fn(),
  loadAgent: vi.fn(),
  resolveAgent: vi.fn(),
}));

vi.mock('@agent/index', async (importActual) => ({
  ...(await importActual<typeof import('@agent/index')>()),
  isRemoteAgent: () => false,
  resolveAgentForLaunch: launchMocks.resolveAgent,
}));
vi.mock('@agent/runtime/agentLoad', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/agentLoad')>()),
  loadAgentSettingAndPrompts: launchMocks.loadAgent,
}));
vi.mock('@agent/runtime/ModelFactory', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/ModelFactory')>()),
  createModelHandler: launchMocks.createHandler,
  createModelHandlerForCompatibilityKey: launchMocks.createHandler,
}));
vi.mock('@agent/prompt/userVars', async (importActual) => ({
  ...(await importActual<typeof import('@agent/prompt/userVars')>()),
  buildUserVars: launchMocks.buildVars,
}));
vi.mock('@agent/storage/executionLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/executionLifecycle')>()),
  hasPersistedParent: (...args: unknown[]) =>
    Effect.promise(() => launchMocks.hasPersistedParent(...args)),
}));
vi.mock('@agent/storage/executionLease', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/executionLease')>()),
  acquireResumedRunLease: launchMocks.acquireResumedExecutionLease,
  assertOwnedRunLease: vi.fn(),
}));

import { clearStoreCache, getRunStore, getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { loadChatExportInput as loadChatExportInputEffect } from '@agent/export/loadChatExportInput';
import { initializeDefaultSession } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import { resumeRun } from '@agent/runtime/resumeRun';
import { flowKey } from '@agent/node/persistedFlow';
import {
  readCliHistoryDetails,
  formatCliHistoryDetailsText,
  cliHistoryDetailNdjsonRecord,
} from '@cli/runtime/history';
import { createHostRunActions } from '@controllers/session/hostRunActions';
import { runWithWorkspaceRoots } from '@platform/workspaceRoots';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  AgentCategory,
  aggregateId,
} from '@shared/schemas';
import type { RunId, StreamTabId, TodoItem } from '@shared/schemas';
import { RunLog } from '@shared/session/traceEntries';
import type { RunLogAppendInput } from '@shared/session/traceEntries';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createProcessSession,
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { settleSessionEvents } from '@test/agent/progressTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import {
  assembleTrace,
  injectStandaloneTrace,
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation as readCompletedRunConversationEffect,
  readCompletedRunTodos,
  RunLogStore,
  RunSnapshotStore,
} from '@transcript';

const tempDirs = useTempDirs();

function runConfig(agent: string, model = 'deepseekproT'): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
  });
}

/** Stamp the execution→stream mapping the way registration does. */
async function stampStreamId(
  executionId: RunId,
  streamId: StreamTabId,
): Promise<void> {
  if (
    !(await Effect.runPromise(
      getRunRecords(taskSession, executionId).readMeta(),
    ))
  ) {
    publishTestRunStart(taskSession, streamId, executionId);
    await taskSession.settlePublications();
  }
}

let taskSession: ReturnType<typeof createTestSession>;
const readCompletedRunConversation = (id: RunId) =>
  Effect.runPromise(readCompletedRunConversationEffect(id, taskSession));
const loadChatExportInput = (id: RunId) =>
  Effect.runPromise(loadChatExportInputEffect(id, taskSession));

/** Persist completed tasks as committed stream events. */
async function seedTasks(
  executionId: RunId,
  streamId: StreamTabId,
  todos: TodoItem[],
): Promise<void> {
  publishTestRunStart(taskSession, streamId, executionId);
  taskSession.publish([
    {
      type: 'updateTodos',
      aggregateId: aggregateId('stream', streamId),
      todos,
    },
  ]);
  await settleSessionEvents();
}

type LogRow = RunLogAppendInput;

let entryCounter = 0;

function logRow(
  messageType: string,
  fields: { text?: string; data?: unknown },
): LogRow {
  entryCounter += 1;
  return {
    id: `entry-${entryCounter}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 1000 + entryCounter,
    messageType: messageType as never,
    ...fields,
  };
}

/** Seed recorded transcript entries through the canonical historical-entry event. */
async function appendRows(
  streamId: StreamTabId,
  rows: readonly LogRow[],
  executionId?: RunId,
): Promise<void> {
  if (!taskSession.transcripts.has(streamId))
    publishTestRunStart(taskSession, streamId, executionId);
  const entries = new RunLog();
  for (const row of rows) entries.appendSettled(row);
  taskSession.publish(
    entries.toJSON().map((entry) => ({
      type: 'transcript.entry',
      aggregateId: aggregateId('stream', streamId),
      entry,
    })),
  );
  await taskSession.settlePublications();
}

async function persistRows(
  executionId: RunId,
  rowsByStream: ReadonlyMap<StreamTabId, readonly LogRow[]>,
): Promise<void> {
  for (const [streamId, rows] of rowsByStream) {
    await appendRows(streamId, rows, executionId);
    taskSession.transcripts.requestEviction(streamId);
  }
}

/** Write transcript rows and committed task events for a completed execution. */
async function writeArchiveFixture(
  executionId: RunId,
  streamId: StreamTabId,
): Promise<void> {
  await seedTasks(executionId, streamId, [
    { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
  ]);

  await appendRows(streamId, [
    logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Fix the lemma.',
      data: { attachments: ['image'] },
    }),
    logRow(MESSAGE_TYPES.THINKING, {
      text: 'Consider the boundary terms.',
    }),
    logRow(MESSAGE_TYPES.WEB_SEARCH, {
      data: {
        query: 'sobolev constant',
        results: [{ url: 'https://example.org/a', title: 'Sobolev notes' }],
        provider: 'anthropic',
        status: 'completed',
      },
    }),
    logRow(MESSAGE_TYPES.WEB_FETCH, {
      data: {
        url: 'https://example.org/a',
        title: 'Sobolev notes',
        provider: 'anthropic',
        callId: 'wf-1',
        status: 'completed',
        content: 'The Sobolev constant satisfies...',
      },
    }),
    logRow(MESSAGE_TYPES.TOOL_USE, {
      data: {
        toolName: 'write_file',
        input: { path: 'notes/lemma.tex' },
        output: 'File written.',
        status: 'completed',
      },
    }),
    // Diagnostic row: deliberately skipped by the mapper (never lived in the
    // legacy conversation.json projection either).
    logRow(MESSAGE_TYPES.STATISTICS, {
      text: 'Usage - input: 10, output: 5',
      data: { inputTokens: 10, outputTokens: 5 },
    }),
    logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Done - the lemma is fixed.',
    }),
  ]);
}

describe('completedRunArchive facade', () => {
  setupPlatform(() => createTempDirPlatform('texra-archive-', tempDirs));

  beforeEach(() => {
    clearStoreCache();
    vi.resetAllMocks();
    taskSession = createProcessSession();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('keeps private metadata exact while public events and exports redact its secrets', async () => {
    taskSession.dispose();
    taskSession = createProcessSession({
      transcriptMode: { kind: 'persistent' },
    });
    const executionId = 'abc654abc654' as RunId;
    const streamId: StreamTabId = executionId;
    const secret = 'sk-private-export-key-1234567890';
    const content = `  retained text ${secret}  `;
    await stampStreamId(executionId, streamId);
    const records = getRunRecords(taskSession, executionId);
    const config = {
      ...runConfig('orchestrator'),
      instruction: content,
      inputFiles: [`paper-${secret}.tex`],
    };
    await Effect.runPromise(records.writeRunRecord(config));
    await Effect.runPromise(records.writeReport(content));
    await Effect.runPromise(
      taskSession.commit([
        {
          type: 'execution.description',
          aggregateId: aggregateId('execution', executionId),
          description: content,
        },
        {
          type: 'updateStreamDescription',
          aggregateId: aggregateId('stream', streamId),
          description: content,
        },
        {
          type: 'run.config',
          aggregateId: aggregateId('stream', streamId),
          executionId,
          config,
        },
        {
          type: 'response.finalized',
          aggregateId: aggregateId('stream', streamId),
          text: 'A public proof.',
        },
      ]),
    );
    expect(await Effect.runPromise(records.readConfig())).toEqual(config);
    expect(await Effect.runPromise(records.readReport())).toBe(content);
    expect((await Effect.runPromise(records.readMeta()))?.description).toBe(
      content,
    );
    const runExecutionRequest = vi.fn(async () => undefined);
    const actions = createHostRunActions({
      session: taskSession,
      runExecutionRequest,
      loadModelOptions: async () => [],
      promptForApiKey: async () => undefined,
      showInfo: vi.fn(),
      showWarning: vi.fn(),
    });
    await Effect.runPromise(actions.runNew(streamId));
    expect(runExecutionRequest).toHaveBeenCalledWith({ config });
    const trace = await Effect.runPromise(
      assembleTrace(executionId, taskSession),
    );
    expect(trace.status).toBe('ok');
    if (trace.status !== 'ok') throw new Error('Expected trace export');
    const exportInput = await loadChatExportInput(executionId);
    const details = await readCliHistoryDetails(executionId);
    expect(details).not.toBeNull();
    if (!details) throw new Error('Expected history details');
    const publicRows = await Effect.runPromise(
      Stream.runCollect(
        taskSession.events.aggregate(aggregateId('stream', streamId), 1),
      ),
    );
    const outputs = [
      injectStandaloneTrace('<script type="module"></script>', trace.trace),
      JSON.stringify(exportInput.exportInput),
      formatCliHistoryDetailsText(details),
      JSON.stringify(cliHistoryDetailNdjsonRecord(details)),
      JSON.stringify(publicRows),
      JSON.stringify(
        SubscriptionRef.getUnsafe(taskSession.view).streams.get(streamId)
          ?.inputFiles,
      ),
      JSON.stringify(
        SubscriptionRef.getUnsafe(taskSession.view).streams.get(streamId)
          ?.description,
      ),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(secret);
      expect(output).toContain('[redacted]');
    }
  });

  it('keeps concurrent exports of the same execution isolated by session roots', async () => {
    const executionId = 'abc456abc456' as RunId;
    const streamId: StreamTabId = executionId;
    const papers = ['first-paper', 'second-paper'].map((label) => ({
      label,
      session: createTestSession(),
    }));
    try {
      await Promise.all(
        papers.map(async ({ session, label }) => {
          publishTestRunStart(session, streamId, executionId);
          await session.settlePublications();
          await Effect.runPromise(
            getRunRecords(session, executionId).writeRunRecord({
              ...runConfig(label),
              instruction: label,
            }),
          );
          await Effect.runPromise(
            session.commit([
              {
                type: 'execution.description',
                aggregateId: aggregateId('execution', executionId),
                description: label,
              },
            ]),
          );
          session.publish([
            {
              type: 'response.finalized',
              aggregateId: aggregateId('stream', streamId),
              text: `Proof for ${label}.`,
            },
          ]);
          await session.settlePublications();
        }),
      );
      const exports = await Effect.runPromise(
        Effect.all(
          papers.map(({ session }) =>
            loadChatExportInputEffect(executionId, session),
          ),
          { concurrency: 2 },
        ),
      );
      expect(
        exports.map((result) => ({
          description: result.meta?.description,
          agent: result.config?.agent,
          instruction: result.exportInput?.config.instruction,
          messages: result.exportInput?.messages,
        })),
      ).toEqual(
        papers.map(({ label }) => ({
          description: label,
          agent: label,
          instruction: label,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: `Proof for ${label}.` }],
            },
          ],
        })),
      );
    } finally {
      for (const { session } of papers) session.dispose();
    }
  });

  it('serves conversation and export from transcripts and tasks from committed events', async () => {
    const executionId = 'abc123abc123' as RunId;
    const streamId: StreamTabId = executionId;
    await writeArchiveFixture(executionId, streamId);

    await Effect.runPromise(
      getRunRecords(taskSession, executionId).writeRunRecord({
        ...runConfig('orchestrator'),
        instruction: 'Fix the lemma.',
      }),
    );
    await stampStreamId(executionId, streamId);

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult.source).toBe('streamLog');
    expect(conversationResult.streamId).toBe(streamId);
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(true);
    expect(conversationResult.conversation).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Fix the lemma.' }, { type: 'image' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Consider the boundary terms.' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            name: 'web_search',
            input: { query: 'sobolev constant' },
          },
          {
            type: 'web_search_tool_result',
            content: [
              {
                type: 'web_search_result',
                url: 'https://example.org/a',
                title: 'Sobolev notes',
              },
            ],
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'web_fetch_tool_result',
            content: {
              type: 'web_fetch_result',
              url: 'https://example.org/a',
              retrieved_at: null,
              content: {
                type: 'document',
                title: 'Sobolev notes',
                source: {
                  type: 'text',
                  data: 'The Sobolev constant satisfies...',
                },
              },
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'write_file',
            input: { path: 'notes/lemma.tex' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'File written.' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done - the lemma is fixed.' }],
      },
    ]);

    // Chat export assembles from the same facade read — no conversation.json.
    const exportResult = await loadChatExportInput(executionId);
    expect(exportResult.exportInput).not.toBeNull();
    expect(exportResult.exportInput?.messages).toEqual(
      conversationResult.conversation,
    );

    expect(
      await Effect.runPromise(readCompletedRunTodos(executionId, taskSession)),
    ).toEqual([
      { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
    ]);
  });

  effectIt.live(
    'reconstructs both turns when the production resume launch reopens the canonical writer',
    () =>
      Effect.gen(function* () {
        const executionId = '0aa1110aa111' as RunId;
        const streamId: StreamTabId = executionId;
        const config = runConfig('orchestrator');

        yield* Effect.promise(() => stampStreamId(executionId, streamId));
        taskSession.dispose();
        const session = initializeDefaultSession({});
        taskSession = session;
        publishTestRunStart(session, streamId, executionId);
        yield* Effect.promise(() => session.settlePublications());
        yield* getRunRecords(session, executionId).writeRunRecord(config);
        session.publish([
          {
            type: 'log',
            aggregateId: aggregateId('stream', streamId),
            level: 'info',
            messageType: MESSAGE_TYPES.USER_MESSAGE,
            message: 'Prove the first lemma.',
          },
          {
            type: 'response.finalized',
            aggregateId: aggregateId('stream', streamId),
            text: 'First proof.',
          },
        ]);
        yield* Effect.promise(() => session.settlePublications());
        const logs = session.transcripts;
        logs.requestEviction(streamId);
        expect(logs.get(streamId)).toBeUndefined();

        const launchFailure = new Error(
          'stop after resumed writer acquisition',
        );
        const leaseModule = yield* Effect.promise(() =>
          vi.importActual<typeof import('@agent/storage/executionLease')>(
            '@agent/storage/executionLease',
          ),
        );
        launchMocks.acquireResumedExecutionLease.mockImplementation(
          leaseModule.acquireResumedRunLease,
        );
        launchMocks.hasPersistedParent.mockResolvedValue(false);
        launchMocks.resolveAgent.mockReturnValue({
          entry: { path: '/agents/orchestrator.yaml' },
        });
        launchMocks.loadAgent.mockResolvedValue([
          { agentCategory: AgentCategory.ToolUse },
          {},
        ]);
        launchMocks.createHandler.mockResolvedValue({
          capabilities: { supportsVision: false, supportsNativeAudio: false },
          config: { provider: 'openai' },
          setAgentCategory: vi.fn(),
          setLogger: vi.fn(),
          dispose: vi.fn(),
        });
        launchMocks.buildVars.mockRejectedValueOnce(launchFailure);

        const persistedResumeState = createToolUseResumeData({
          executionId,
          streamId,
          agentConfig: config,
          shared: {
            modelHandlerCompatibilityKey: 'ModelHandlerOpenAIResponse',
          },
        });
        yield* Effect.promise(() =>
          getRunStore(executionId).write(flowKey(executionId), {
            shared: persistedResumeState.shared,
            cursor: { nextNodeId: 'start' },
          }),
        );

        const acquireRunResidency = logs.acquireRunResidency.bind(logs);
        const resumedWriter = vi
          .spyOn(logs, 'acquireRunResidency')
          .mockImplementationOnce((requestedStreamId, ownerKey) =>
            Effect.gen(function* () {
              const writer = yield* acquireRunResidency(
                requestedStreamId,
                ownerKey,
              );
              session.publish([
                {
                  type: 'log',
                  aggregateId: aggregateId('stream', streamId),
                  level: 'info',
                  messageType: MESSAGE_TYPES.USER_MESSAGE,
                  message: 'Now prove the second lemma.',
                },
                {
                  type: 'response.finalized',
                  aggregateId: aggregateId('stream', streamId),
                  text: 'Second proof.',
                },
              ]);
              yield* Effect.promise(() => session.settlePublications());
              return writer;
            }),
          );

        expect(
          yield* Effect.flip(
            resumeRun(executionId, {
              session,
              executeWorkflow: vi.fn(async () => undefined),
            }),
          ),
        ).toBe(launchFailure);

        expect(resumedWriter).toHaveBeenCalledWith(streamId, executionId);
        const released = yield* Effect.result(
          getRunRecords(session, executionId).writeReport('late write'),
        );
        expect(released._tag).toBe('Failure');
        expect(
          (yield* Effect.exit(
            session.commit([
              {
                type: 'log',
                aggregateId: aggregateId('stream', streamId),
                level: 'info',
                message: 'late stream write',
              },
            ]),
          ))._tag,
        ).toBe('Failure');
        expect(
          yield* Effect.promise(() =>
            runInSession(session, () =>
              leaseModule.inspectRunLease(executionId),
            ),
          ),
        ).toEqual({ status: 'free' });
        resumedWriter.mockRestore();

        const archived = yield* readCompletedRunConversationEffect(
          executionId,
          session,
        );
        expect(archived).toEqual({
          source: 'streamLog',
          streamId,
          conversation: [
            { role: 'user', content: 'Prove the first lemma.' },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'First proof.' }],
            },
            { role: 'user', content: 'Now prove the second lemma.' },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Second proof.' }],
            },
          ],
        });

        const endpoint = yield* Effect.promise(() =>
          new ExecutionsTool().call({
            path: `/executions/${executionId}/conversation`,
          }),
        );
        expect(endpoint.status).toBe('executed');
        expect(endpoint.output).toContain('Conversation (4 messages)');
        expect(endpoint.output).toContain('Prove the first lemma.');
        expect(endpoint.output).toContain('First proof.');
        expect(endpoint.output).toContain('Now prove the second lemma.');
        expect(endpoint.output).toContain('Second proof.');

        const firstPage = yield* Effect.promise(() =>
          new ExecutionsTool().call({
            path: `/executions/${executionId}/conversation`,
            offset: 0,
            limit: 2,
          }),
        );
        const secondPage = yield* Effect.promise(() =>
          new ExecutionsTool().call({
            path: `/executions/${executionId}/conversation`,
            offset: 2,
            limit: 2,
          }),
        );
        expect(firstPage.output).toContain('Source: streamLog');
        expect(firstPage.output).toContain(`Stream: ${streamId}`);
        expect(firstPage.output).toContain('Returned message interval: [0, 2)');
        expect(firstPage.output).toContain('Next offset: 2');
        expect(firstPage.output).toContain('<message index="1"');
        expect(firstPage.output).toContain('<message index="2"');
        expect(firstPage.output).not.toContain('Now prove the second lemma.');
        expect(secondPage.output).toContain(
          'Returned message interval: [2, 4)',
        );
        expect(secondPage.output).toContain('Next offset: none');
        expect(secondPage.output).toContain('<message index="3"');
        expect(secondPage.output).toContain('<message index="4"');
        expect(secondPage.output).not.toContain('Prove the first lemma.');

        for (const text of [
          'Prove the first lemma.',
          'First proof.',
          'Now prove the second lemma.',
          'Second proof.',
        ]) {
          expect(
            `${firstPage.output}\n${secondPage.output}`.split(text),
          ).toHaveLength(2);
        }

        const lineRange = yield* Effect.promise(() =>
          new ExecutionsTool().call({
            path: `/executions/${executionId}/conversation`,
            view_range: [1, 10],
          }),
        );
        expect(lineRange.status).toBe('error');
        expect(lineRange.error).toContain(
          'Conversation pagination is message-based. Use offset and limit',
        );
      }),
  );

  it('reads an empty task list from a committed empty work plan', async () => {
    const executionId = '0aa2220aa222' as RunId;
    const streamId: StreamTabId = executionId;
    await seedTasks(executionId, streamId, []);
    await stampStreamId(executionId, streamId);

    expect(
      await Effect.runPromise(readCompletedRunTodos(executionId, taskSession)),
    ).toEqual([]);
  });

  it('reports none, with no conversation evidence, when metadata has no stamped stream', async () => {
    const executionId = 'ccc333ccc333' as RunId;

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(false);

    expect(
      await Effect.runPromise(readCompletedRunTodos(executionId, taskSession)),
    ).toEqual([]);
  });

  it('reads a registered execution without sidecar or suffix scans, even when its transcript is empty (#9590 A1)', async () => {
    const executionId = 'abc907abc907' as RunId;
    const streamId: StreamTabId = executionId;
    await stampStreamId(executionId, streamId);
    // A decoy stream that a suffix scan would match; the run's own (empty)
    // stream is authoritative.
    await persistRows(
      'dec000001' as RunId,
      new Map([
        [
          `other@model#${executionId}` as StreamTabId,
          [logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'decoy row' })],
        ],
      ]),
    );

    const scan = vi.spyOn(RunSnapshotStore.prototype, 'listPersistedStreams');

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({
      conversation: null,
      source: 'none',
      streamId,
    });
    // The run's registered stream alone is association evidence.
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(true);

    expect(
      await Effect.runPromise(readCompletedRunTodos(executionId, taskSession)),
    ).toEqual([]);

    expect(scan).not.toHaveBeenCalled();
  });

  it('reads a sidecar conversation', async () => {
    const executionId = 'ddd444ddd444' as RunId;
    const streamId: StreamTabId = executionId;
    await writeArchiveFixture(executionId, streamId);
    await stampStreamId(executionId, streamId);
    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('streamLog');
    expect(result.streamId).toBe(streamId);
    expect(result.conversation).not.toBeNull();
    expect(result.conversation?.length).toBeGreaterThan(0);
  });

  it('reconstructs structured successful and failed tool results as model-facing text', async () => {
    const executionId = '0ee5550ee555' as RunId;
    const streamId: StreamTabId = executionId;

    await stampStreamId(executionId, streamId);

    await appendRows(streamId, [
      logRow(MESSAGE_TYPES.TOOL_USE, {
        data: {
          toolName: 'write_file',
          input: { path: 'proof.tex' },
          output: { output: 'File written.' },
          status: 'completed',
        },
      }),
      logRow(MESSAGE_TYPES.TOOL_USE, {
        data: {
          toolName: 'read_file',
          input: { path: 'missing.tex' },
          output: { error: 'File not found.' },
          isError: true,
          status: 'failed',
        },
      }),
    ]);

    const result = await readCompletedRunConversation(executionId);
    expect(result.conversation).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'write_file',
            input: { path: 'proof.tex' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'File written.' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'read_file',
            input: { path: 'missing.tex' },
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: 'File not found.' }],
      },
    ]);
  });

  it('preserves a diagnostic-only run stream as execution evidence without a conversation', async () => {
    const executionId = '0999cb0999cb' as RunId;
    const root: StreamTabId = executionId;

    await stampStreamId(executionId, root);

    await appendRows(root, [
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Root status only' }),
    ]);

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      conversation: null,
      source: 'none',
      streamId: root,
    });
    expect(hasCompletedRunConversationEvidence(result)).toBe(true);

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain('Conversation (0 messages)');
    expect(endpoint.output).toContain(`Stream: ${root}`);
  });

  it('never substitutes another stream for an empty run stream', async () => {
    const executionId = '0999cc0999cc' as RunId;
    const root: StreamTabId = executionId;
    const child = 'child@tool#0999cc0999cc' as StreamTabId;

    await stampStreamId(executionId, root);

    await appendRows(root, [
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Root status only' }),
    ]);
    await appendRows(child, [
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Child-only prompt' }),
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Child-only answer' }),
    ]);

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      conversation: null,
      source: 'none',
      streamId: root,
    });
  });
});
