import { it } from '@effect/vitest';
/** Completed conversation reads and task reads through the archive facade. */
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const launchMocks = vi.hoisted(() => ({
  buildVars: vi.fn(),
  loadAgent: vi.fn(),
  resolveAgent: vi.fn(),
}));

vi.mock('@agent/index', async (importActual) => ({
  ...(await importActual<typeof import('@agent/index')>()),
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

import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { loadChatExportInput as loadChatExportInputEffect } from '@agent/export/loadChatExportInput';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { initializeDefaultSession } from '@agent/runtime/sessionGraph';
import { resumeRun } from '@agent/runtime/resumeRun';
import { closeSession } from '@agent/runtime/sessionGraph';
import { withProcessServices } from '@platform/processRuntime';
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
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
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
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { settleSessionEvents } from '@test/agent/progressTestUtils';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation as readCompletedRunConversationEffect,
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
    await Effect.runPromise(taskSession.settlePublications());
  }
}

let taskSession: ReturnType<typeof createTestSession>;
const readCompletedRunConversation = (id: RunId) =>
  Effect.runPromise(readCompletedRunConversationEffect(id, taskSession));
/** The run's task list as every surface reads it: off the session fold. */
const completedRunTodos = (id: RunId) =>
  Effect.runPromise(
    taskSession.readView([id]).pipe(
      Effect.map((view) => {
        const run = view.runs.get(id);
        return run?.category === AgentCategory.ToolUse ? run.todos : [];
      }),
    ),
  );
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
      type: 'run.fact',
      aggregateId: aggregateId('run', runId),
      fact: { key: 'todos', todos },
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
  if (taskSession.runView(runId) === undefined)
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
  await Effect.runPromise(taskSession.settlePublications());
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
      data: { query: 'sobolev constant' },
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

  beforeEach(async () => {
    vi.resetAllMocks();
    taskSession = await Effect.runPromise(createProcessSession());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // it.live: the release at the end of this test closes both sessions through
  // `closeSession`, whose settlement budget is
  // `Effect.sleep(SHUTDOWN_PHASE_DEADLINE_MS)`. With no active runs that arm
  // is never awaited today, so the happy path would also pass on the test
  // clock. The live clock is kept for the regression case: under TestClock
  // nothing advances that sleep, so a session that stopped settling could
  // never reach the `Test session did not close` failure and would surface as
  // a suite timeout instead of a named assertion.
  it.live(
    'keeps concurrent exports of the same run isolated by session roots',
    () =>
      Effect.gen(function* () {
        const runId = 'abc456abc456' as RunId;
        // Both sessions close on every exit of this test, interruption
        // included; a close failure is the defect the old `finally` threw.
        const papers = yield* Effect.acquireRelease(
          Effect.sync(() =>
            ['first-paper', 'second-paper'].map((label) => ({
              label,
              session: createTestSession(),
            })),
          ),
          (open) =>
            Effect.forEach(open, ({ session }) => closeTestSession(session), {
              concurrency: 'unbounded',
              discard: true,
            }).pipe(Effect.orDie),
        );
        yield* Effect.forEach(
          papers,
          ({ session, label }) =>
            Effect.gen(function* () {
              publishTestRunStart(session, runId);
              yield* session.settlePublications();
              yield* getRunRecords(session, runId).writeRunRecord({
                ...runConfig(label),
                instruction: label,
              });
              yield* session.commit([
                {
                  type: 'run.description',
                  aggregateId: aggregateId('run', runId),
                  description: label,
                },
              ]);
              session.publish([
                {
                  type: 'response.finalized',
                  aggregateId: aggregateId('run', runId),
                  text: `Proof for ${label}.`,
                },
              ]);
              yield* session.settlePublications();
            }),
          { concurrency: 'unbounded', discard: true },
        );
        const exports = yield* Effect.all(
          papers.map(({ session }) =>
            loadChatExportInputEffect(runId, session),
          ),
          { concurrency: 2 },
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
      }),
  );

  it.effect(
    'serves conversation and export from transcripts and tasks from committed events',
    () =>
      Effect.gen(function* () {
        const runId = 'abc123abc123' as RunId;
        yield* Effect.promise(() => writeArchiveFixture(runId));

        yield* getRunRecords(taskSession, runId).writeRunRecord({
          ...runConfig('orchestrator'),
          instruction: 'Fix the lemma.',
        });
        yield* Effect.promise(() => stampRun(runId));

        const conversationResult = yield* Effect.promise(() =>
          readCompletedRunConversation(runId),
        );
        expect(conversationResult.source).toBe('streamLog');
        expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(
          true,
        );
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
            kind: 'tool-call',
            name: 'write_file',
            input: { path: 'notes/lemma.tex' },
          },
          { kind: 'tool-result', text: 'File written.' },
          { kind: 'assistant-text', text: 'Done - the lemma is fixed.' },
        ]);

        // Chat export assembles from the same facade read — no conversation.json.
        const exportResult = yield* Effect.promise(() =>
          loadChatExportInput(runId),
        );
        expect(exportResult.exportInput).not.toBeNull();
        expect(exportResult.exportInput?.nodes).toEqual(
          conversationResult.conversation,
        );

        expect(yield* Effect.promise(() => completedRunTodos(runId))).toEqual([
          {
            content: 'Fix the bug',
            status: 'completed',
            activeForm: 'Fixing',
          },
        ]);
      }),
  );

  it.live(
    'reconstructs both turns when the production resume launch reopens the canonical writer',
    () =>
      Effect.gen(function* () {
        const runId = '0aa1110aa111' as RunId;
        const config = runConfig('orchestrator');

        yield* Effect.promise(() => stampRun(runId));
        yield* closeTestSession(taskSession);
        const session = yield* initializeDefaultSession({
          roots: testWorkspaceRoots(),
        });
        taskSession = session;
        publishTestRunStart(session, runId);
        yield* session.settlePublications();
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
        yield* session.settlePublications();

        const launchFailure = new Error(
          'stop after resumed writer acquisition',
        );
        launchMocks.resolveAgent.mockReturnValue(
          Effect.succeed({
            path: '/agents/orchestrator.yaml',
          }),
        );
        launchMocks.loadAgent.mockReturnValue(
          Effect.succeed([{ agentCategory: AgentCategory.ToolUse }, {}]),
        );
        launchMocks.buildVars.mockReturnValueOnce(Effect.fail(launchFailure));

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
                declinedRoutes: [],
              },
              state: {
                stateSlices: null,
                offeredTools: [],
                toolsetHash: '0'.repeat(64),
              },
            }),
          },
        ]);

        const attachRunTrace = session.attachRunTrace.bind(session);
        const resumedWriter = vi
          .spyOn(session, 'attachRunTrace')
          .mockImplementationOnce((trace, requestedRunId) => {
            const detach = attachRunTrace(trace, requestedRunId);
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
            return detach;
          });

        expect(
          yield* Effect.flip(
            resumeRun(runId, {
              session,
              executeWorkflow: vi.fn(() => Effect.void),
            }),
          ),
        ).toBe(launchFailure);

        expect(resumedWriter).toHaveBeenCalledWith(expect.anything(), runId);
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
        expect(yield* session.ownsRun(runId)).toBe(false);
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
          roots: taskSession.roots,
        });

        const endpoint = yield* ExecutionsTool.call({
          path: `/executions/${runId}/conversation`,
        }).pipe(Effect.provide(toolLayer));
        expect(endpoint.status).toBe('executed');
        expect(endpoint.output).toContain('Conversation (4 messages)');
        expect(endpoint.output).toContain('Prove the first lemma.');
        expect(endpoint.output).toContain('First proof.');
        expect(endpoint.output).toContain('Now prove the second lemma.');
        expect(endpoint.output).toContain('Second proof.');

        const firstPage = yield* ExecutionsTool.call({
          path: `/executions/${runId}/conversation`,
          offset: 0,
          limit: 2,
        }).pipe(Effect.provide(toolLayer));
        const secondPage = yield* ExecutionsTool.call({
          path: `/executions/${runId}/conversation`,
          offset: 2,
          limit: 2,
        }).pipe(Effect.provide(toolLayer));
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

        const lineRange = yield* ExecutionsTool.call({
          path: `/executions/${runId}/conversation`,
          view_range: [1, 10],
        }).pipe(Effect.provide(toolLayer));
        expect(lineRange.status).toBe('error');
        expect(lineRange.error).toContain(
          'Conversation pagination is message-based. Use offset and limit',
        );
        // Use the installed session owner's services, including its persistent
        // project database map.
      }).pipe((program) => withProcessServices(testRuntime(), program)),
  );

  it('reports none, with no conversation evidence, when the run has no transcript', async () => {
    const runId = 'ccc333ccc333' as RunId;

    const conversationResult = await readCompletedRunConversation(runId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(false);

    expect(await completedRunTodos(runId)).toEqual([]);
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

    expect(await completedRunTodos(runId)).toEqual([]);
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

  it.live('reports a diagnostic-only transcript as no conversation', () =>
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

      const endpoint = yield* ExecutionsTool.call({
        path: `/executions/${runId}/conversation`,
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { session: taskSession, runId, toolPolicy: {} },
            roots: taskSession.roots,
          }),
        ),
      );
      expect(endpoint.status).toBe('executed');
      expect(endpoint.output).toContain('Conversation (0 messages)');
    }),
  );
});
