import { it as effectIt } from '@effect/vitest';
/** Completed conversation reads and task reads through the archive facade. */
import { Effect, Stream, SubscriptionRef } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchMocks = vi.hoisted(() => ({
  acquireResumedRunLease: vi.fn(),
  buildVars: vi.fn(),
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
vi.mock('@agent/prompt/userVars', async (importActual) => ({
  ...(await importActual<typeof import('@agent/prompt/userVars')>()),
  buildUserVars: launchMocks.buildVars,
}));
vi.mock('@agent/storage/runLease', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/runLease')>()),
  acquireResumedRunLease: launchMocks.acquireResumedRunLease,
  assertOwnedRunLease: vi.fn(),
}));

import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { loadChatExportInput as loadChatExportInputEffect } from '@agent/export/loadChatExportInput';
import {
  initializeDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import { resumeRun } from '@agent/runtime/resumeRun';
import { closeSession } from '@agent/runtime/sessionGraph';
import {
  readCliHistoryDetails,
  formatCliHistoryDetailsText,
  cliHistoryDetailNdjsonRecord,
} from '@cli/runtime/history';
import { createHostRunActions } from '@controllers/session/hostRunActions';
import { Secrets } from '@platform/secrets';
import { runWithWorkspaceRoots } from '@platform/workspaceRoots';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  AgentCategory,
  aggregateId,
  FlowSnapshotPayloadSchema,
} from '@shared/schemas';
import type { RunId, TodoItem } from '@shared/schemas';
import type { StreamLogAppendInput } from '@shared/session/traceEntries';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  fakeProcessServices,
  installedHost,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  createProcessSession,
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { settleSessionEvents } from '@test/agent/progressTestUtils';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import {
  assembleTrace,
  injectStandaloneTrace,
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation as readCompletedRunConversationEffect,
  readCompletedRunTodos,
} from '@transcript';

const tempDirs = useTempDirs();

function runConfig(agent: string, model = 'deepseekproT'): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
  });
}

/** Publish the run's existence the way registration does. */
async function stampRun(runId: RunId): Promise<void> {
  const view = await Effect.runPromise(taskSession.readView([runId]));
  if (!view.runs.has(runId)) {
    publishTestRunStart(taskSession, runId);
    await taskSession.settlePublications();
  }
}

let taskSession: ReturnType<typeof createTestSession>;
const readCompletedRunConversation = (id: RunId) =>
  Effect.runPromise(readCompletedRunConversationEffect(id, taskSession));
const loadChatExportInput = (id: RunId) =>
  Effect.runPromise(loadChatExportInputEffect(id, taskSession));

function closeTestSession(session: SessionHandle): Effect.Effect<void, Error> {
  return closeSession(session.roots.storage).pipe(
    Effect.flatMap((report) =>
      report.settled && report.abandoned.length === 0
        ? Effect.void
        : Effect.fail(
            new Error(
              `Test session did not close: ${report.abandoned.join(', ')}`,
            ),
          ),
    ),
  );
}

/** Persist completed tasks as committed run events. */
async function seedTasks(runId: RunId, todos: TodoItem[]): Promise<void> {
  publishTestRunStart(taskSession, runId);
  taskSession.publish([
    {
      type: 'updateTodos',
      aggregateId: aggregateId('run', runId),
      todos,
    },
  ]);
  await settleSessionEvents();
}

type LogRow = StreamLogAppendInput;

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

/** Seed recorded transcript rows through the durable log fact. */
async function appendRows(
  runId: RunId,
  rows: readonly LogRow[],
): Promise<void> {
  if (!taskSession.transcripts.has(runId))
    publishTestRunStart(taskSession, runId);
  taskSession.publish(
    rows.map((row) => ({
      type: 'log' as const,
      aggregateId: aggregateId('run', runId),
      level: row.level,
      message: row.text ?? '',
      messageType: row.messageType,
      data: row.data,
    })),
  );
  await taskSession.settlePublications();
}

/** Write transcript rows and committed task events for a completed run. */
async function writeArchiveFixture(runId: RunId): Promise<void> {
  await seedTasks(runId, [
    { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
  ]);

  await appendRows(runId, [
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
    vi.resetAllMocks();
    taskSession = createProcessSession();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('keeps private metadata exact while public events and exports redact its secrets', async () => {
    await Effect.runPromise(closeTestSession(taskSession));
    taskSession = createProcessSession({
      transcriptMode: { kind: 'persistent' },
    });
    const runId = 'abc654abc654' as RunId;
    const secret = 'sk-private-export-key-1234567890';
    const content = `  retained text ${secret}  `;
    await stampRun(runId);
    const records = getRunRecords(taskSession, runId);
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
          type: 'run.description',
          aggregateId: aggregateId('run', runId),
          description: content,
        },
        {
          type: 'run.config',
          aggregateId: aggregateId('run', runId),
          config,
        },
        {
          type: 'response.finalized',
          aggregateId: aggregateId('run', runId),
          text: 'A public proof.',
        },
      ]),
    );
    expect(await Effect.runPromise(records.readConfig())).toEqual(config);
    expect(await Effect.runPromise(records.readReport())).toBe(content);
    // The run's one `run.description` row is redacted on the way into the
    // event table, so every reader of it — the view's fold included, asserted
    // below — sees the redacted text; the private sidecars above stay exact.
    const runAgentRequest = vi.fn(async () => undefined);
    const actions = await Effect.runPromise(
      createHostRunActions({
        session: taskSession,
        runAgentRequest,
        loadModelOptions: async () => [],
        promptForApiKey: async () => undefined,
        showInfo: vi.fn(),
        showWarning: vi.fn(),
      }).pipe(
        Effect.provide(Secrets.layer(() => installedHost().platform.secrets)),
      ),
    );
    await Effect.runPromise(actions.runNew(runId));
    expect(runAgentRequest).toHaveBeenCalledWith({ config });
    const trace = await Effect.runPromise(assembleTrace(runId, taskSession));
    expect(trace.status).toBe('ok');
    if (trace.status !== 'ok') throw new Error('Expected trace export');
    const exportInput = await loadChatExportInput(runId);
    const { secrets, globalState } = installedHost().platform;
    const details = await readCliHistoryDetails(
      { secrets, globalState },
      runId,
    );
    expect(details).not.toBeNull();
    if (!details) throw new Error('Expected history details');
    const publicRows = await Effect.runPromise(
      Stream.runCollect(
        taskSession.events.aggregate(aggregateId('run', runId), 1),
      ),
    );
    const outputs = [
      injectStandaloneTrace('<script type="module"></script>', trace.trace),
      JSON.stringify(exportInput.exportInput),
      formatCliHistoryDetailsText(details),
      JSON.stringify(cliHistoryDetailNdjsonRecord(details)),
      JSON.stringify(publicRows),
      JSON.stringify(
        SubscriptionRef.getUnsafe(taskSession.view).runs.get(runId)?.inputFiles,
      ),
      JSON.stringify(
        SubscriptionRef.getUnsafe(taskSession.view).runs.get(runId)
          ?.description,
      ),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(secret);
      expect(output).toContain('[redacted]');
    }
  });

  it('keeps concurrent exports of the same run isolated by session roots', async () => {
    const runId = 'abc456abc456' as RunId;
    const papers = ['first-paper', 'second-paper'].map((label) => ({
      label,
      session: createTestSession(),
    }));
    try {
      await Promise.all(
        papers.map(async ({ session, label }) => {
          publishTestRunStart(session, runId);
          await session.settlePublications();
          await Effect.runPromise(
            getRunRecords(session, runId).writeRunRecord({
              ...runConfig(label),
              instruction: label,
            }),
          );
          await Effect.runPromise(
            session.commit([
              {
                type: 'run.description',
                aggregateId: aggregateId('run', runId),
                description: label,
              },
            ]),
          );
          session.publish([
            {
              type: 'response.finalized',
              aggregateId: aggregateId('run', runId),
              text: `Proof for ${label}.`,
            },
          ]);
          await session.settlePublications();
        }),
      );
      const exports = await Effect.runPromise(
        Effect.all(
          papers.map(({ session }) =>
            loadChatExportInputEffect(runId, session),
          ),
          { concurrency: 2 },
        ),
      );
      expect(
        exports.map((result) => ({
          description: result.run?.description,
          agent: result.config?.agent,
          instruction: result.exportInput?.config.instruction,
          nodes: result.exportInput?.nodes,
        })),
      ).toEqual(
        papers.map(({ label }) => ({
          description: label,
          agent: label,
          instruction: label,
          nodes: [{ kind: 'assistant-text', text: `Proof for ${label}.` }],
        })),
      );
    } finally {
      await Effect.runPromise(
        Effect.forEach(papers, ({ session }) => closeTestSession(session), {
          concurrency: 'unbounded',
          discard: true,
        }),
      );
    }
  });

  it('serves conversation and export from transcripts and tasks from committed events', async () => {
    const runId = 'abc123abc123' as RunId;
    await writeArchiveFixture(runId);

    await Effect.runPromise(
      getRunRecords(taskSession, runId).writeRunRecord({
        ...runConfig('orchestrator'),
        instruction: 'Fix the lemma.',
      }),
    );
    await stampRun(runId);

    const conversationResult = await readCompletedRunConversation(runId);
    expect(conversationResult.source).toBe('streamLog');
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(true);
    expect(conversationResult.conversation).toEqual([
      {
        kind: 'user-message',
        parts: [
          { type: 'text', text: 'Fix the lemma.' },
          { type: 'attachment', attachmentType: 'image' },
        ],
      },
      { kind: 'thinking', text: 'Consider the boundary terms.' },
      { kind: 'web-search', query: 'sobolev constant' },
      {
        kind: 'web-search-results',
        results: [{ url: 'https://example.org/a', title: 'Sobolev notes' }],
      },
      {
        kind: 'web-fetch',
        url: 'https://example.org/a',
        title: 'Sobolev notes',
        content: 'The Sobolev constant satisfies...',
      },
      {
        kind: 'tool-call',
        name: 'write_file',
        input: { path: 'notes/lemma.tex' },
      },
      { kind: 'tool-result', text: 'File written.' },
      { kind: 'assistant-text', text: 'Done - the lemma is fixed.' },
    ]);

    // Chat export assembles from the same facade read — no conversation.json.
    const exportResult = await loadChatExportInput(runId);
    expect(exportResult.exportInput).not.toBeNull();
    expect(exportResult.exportInput?.nodes).toEqual(
      conversationResult.conversation,
    );

    expect(
      await Effect.runPromise(readCompletedRunTodos(runId, taskSession)),
    ).toEqual([
      { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
    ]);
  });

  effectIt.live(
    'reconstructs both turns when the production resume launch reopens the canonical writer',
    () =>
      Effect.gen(function* () {
        const runId = '0aa1110aa111' as RunId;
        const config = runConfig('orchestrator');

        yield* Effect.promise(() => stampRun(runId));
        yield* closeTestSession(taskSession);
        const session = initializeDefaultSession({});
        taskSession = session;
        publishTestRunStart(session, runId);
        yield* Effect.promise(() => session.settlePublications());
        yield* getRunRecords(session, runId).writeRunRecord(config);
        session.publish([
          {
            type: 'log',
            aggregateId: aggregateId('run', runId),
            level: 'info',
            messageType: MESSAGE_TYPES.USER_MESSAGE,
            message: 'Prove the first lemma.',
          },
          {
            type: 'response.finalized',
            aggregateId: aggregateId('run', runId),
            text: 'First proof.',
          },
        ]);
        yield* Effect.promise(() => session.settlePublications());
        const logs = session.transcripts;
        logs.requestEviction(runId);
        expect(logs.get(runId)).toBeUndefined();

        const launchFailure = new Error(
          'stop after resumed writer acquisition',
        );
        const leaseModule = yield* Effect.promise(() =>
          vi.importActual<typeof import('@agent/storage/runLease')>(
            '@agent/storage/runLease',
          ),
        );
        launchMocks.acquireResumedRunLease.mockImplementation(
          leaseModule.acquireResumedRunLease,
        );
        launchMocks.resolveAgent.mockReturnValue({
          path: '/agents/orchestrator.yaml',
        });
        launchMocks.loadAgent.mockResolvedValue([
          { agentCategory: AgentCategory.ToolUse },
          {},
        ]);
        launchMocks.buildVars.mockRejectedValueOnce(launchFailure);

        // The one fact a resume reads: the run aggregate's latest
        // `flow.snapshot`, committed here as this run's opening row.
        yield* session.commit([
          {
            type: 'flow.snapshot',
            aggregateId: aggregateId('run', runId),
            payload: FlowSnapshotPayloadSchema.parse({
              family: 'toolUse',
              runtime: {
                phase: 'waiting',
                round: 0,
                turn: 0,
                continuationIndex: 0,
                modelId: config.model,
                modelCompatibilityKey: 'OpenAIResponse',
                lastError: null,
                pendingRetry: null,
                declinedRoutes: [],
              },
              references: { pendingIntents: [], pendingResponse: null },
              state: { shouldSkipCycle: false, stateSlices: null },
            }),
          },
        ]);

        const acquireRunResidency = logs.acquireRunResidency.bind(logs);
        const resumedWriter = vi
          .spyOn(logs, 'acquireRunResidency')
          .mockImplementationOnce((requestedRunId) =>
            Effect.gen(function* () {
              const writer = yield* acquireRunResidency(requestedRunId);
              session.publish([
                {
                  type: 'log',
                  aggregateId: aggregateId('run', runId),
                  level: 'info',
                  messageType: MESSAGE_TYPES.USER_MESSAGE,
                  message: 'Now prove the second lemma.',
                },
                {
                  type: 'response.finalized',
                  aggregateId: aggregateId('run', runId),
                  text: 'Second proof.',
                },
              ]);
              yield* Effect.promise(() => session.settlePublications());
              return writer;
            }),
          );

        expect(
          yield* Effect.flip(
            resumeRun(runId, {
              session,
              executeWorkflow: vi.fn(async () => undefined),
            }),
          ),
        ).toBe(launchFailure);

        expect(resumedWriter).toHaveBeenCalledWith(runId);
        const released = yield* Effect.result(
          getRunRecords(session, runId).writeReport('late write'),
        );
        expect(released._tag).toBe('Failure');
        expect(
          (yield* Effect.exit(
            session.commit([
              {
                type: 'log',
                aggregateId: aggregateId('run', runId),
                level: 'info',
                message: 'late stream write',
              },
            ]),
          ))._tag,
        ).toBe('Failure');
        expect(
          yield* Effect.promise(() =>
            runInSession(session, () => leaseModule.inspectRunLease(runId)),
          ),
        ).toEqual({ status: 'free' });
        resumedWriter.mockRestore();

        const archived = yield* readCompletedRunConversationEffect(
          runId,
          session,
        );
        expect(archived).toEqual({
          source: 'streamLog',
          conversation: [
            {
              kind: 'user-message',
              parts: [{ type: 'text', text: 'Prove the first lemma.' }],
            },
            { kind: 'assistant-text', text: 'First proof.' },
            {
              kind: 'user-message',
              parts: [{ type: 'text', text: 'Now prove the second lemma.' }],
            },
            { kind: 'assistant-text', text: 'Second proof.' },
          ],
        });

        const toolLayer = nativeToolTestLayer({
          run: { session: taskSession, runId, toolPolicy: {} },
          inScope: (operation) =>
            runWithWorkspaceRoots(taskSession.roots, operation),
        });

        const endpoint = yield* new ExecutionsTool()
          .call({
            path: `/executions/${runId}/conversation`,
          })
          .pipe(Effect.provide(toolLayer));
        expect(endpoint.status).toBe('executed');
        expect(endpoint.output).toContain('Conversation (4 messages)');
        expect(endpoint.output).toContain('Prove the first lemma.');
        expect(endpoint.output).toContain('First proof.');
        expect(endpoint.output).toContain('Now prove the second lemma.');
        expect(endpoint.output).toContain('Second proof.');

        const firstPage = yield* new ExecutionsTool()
          .call({
            path: `/executions/${runId}/conversation`,
            offset: 0,
            limit: 2,
          })
          .pipe(Effect.provide(toolLayer));
        const secondPage = yield* new ExecutionsTool()
          .call({
            path: `/executions/${runId}/conversation`,
            offset: 2,
            limit: 2,
          })
          .pipe(Effect.provide(toolLayer));
        expect(firstPage.output).toContain('Source: streamLog');
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

        const lineRange = yield* new ExecutionsTool()
          .call({
            path: `/executions/${runId}/conversation`,
            view_range: [1, 10],
          })
          .pipe(Effect.provide(toolLayer));
        expect(lineRange.status).toBe('error');
        expect(lineRange.error).toContain(
          'Conversation pagination is message-based. Use offset and limit',
        );
        // The production resume path resolves tools from `ToolInjections`, a
        // process service this program does not inherit from the test runtime.
      }).pipe(Effect.provide(fakeProcessServices())),
  );

  it('reports none, with no conversation evidence, when the run has no transcript', async () => {
    const runId = 'ccc333ccc333' as RunId;

    const conversationResult = await readCompletedRunConversation(runId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(false);

    expect(
      await Effect.runPromise(readCompletedRunTodos(runId, taskSession)),
    ).toEqual([]);
  });

  it('reads a registered run whose transcript is empty', async () => {
    const runId = 'abc907abc907' as RunId;
    await stampRun(runId);

    const conversationResult = await readCompletedRunConversation(runId);
    expect(conversationResult).toEqual({
      conversation: null,
      source: 'none',
    });
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(false);

    expect(
      await Effect.runPromise(readCompletedRunTodos(runId, taskSession)),
    ).toEqual([]);
  });

  it('reconstructs structured successful and failed tool results as model-facing text', async () => {
    const runId = '0ee5550ee555' as RunId;

    await stampRun(runId);

    await appendRows(runId, [
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
          status: 'failed',
        },
      }),
    ]);

    const result = await readCompletedRunConversation(runId);
    expect(result.conversation).toEqual([
      {
        kind: 'tool-call',
        name: 'write_file',
        input: { path: 'proof.tex' },
      },
      { kind: 'tool-result', text: 'File written.' },
      {
        kind: 'tool-call',
        name: 'read_file',
        input: { path: 'missing.tex' },
      },
      { kind: 'tool-result', text: 'File not found.' },
    ]);
  });

  effectIt.live('reports a diagnostic-only transcript as no conversation', () =>
    Effect.gen(function* () {
      const runId = '0999cb0999cb' as RunId;

      yield* Effect.promise(() => stampRun(runId));

      yield* Effect.promise(() =>
        appendRows(runId, [
          logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Root status only' }),
        ]),
      );

      const result = yield* Effect.promise(() =>
        readCompletedRunConversation(runId),
      );
      expect(result).toEqual({
        conversation: null,
        source: 'none',
      });
      expect(hasCompletedRunConversationEvidence(result)).toBe(false);

      const endpoint = yield* new ExecutionsTool()
        .call({
          path: `/executions/${runId}/conversation`,
        })
        .pipe(
          Effect.provide(
            nativeToolTestLayer({
              run: { session: taskSession, runId, toolPolicy: {} },
              inScope: (operation) =>
                runWithWorkspaceRoots(taskSession.roots, operation),
            }),
          ),
        );
      expect(endpoint.status).toBe('executed');
      expect(endpoint.output).toContain('Conversation (0 messages)');
    }),
  );
});
