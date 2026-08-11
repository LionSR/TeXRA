/**
 * Completed-run archive facade: the transcript sidecars own completed-run
 * display/export, with `executions/{id}/conversation.json` / `todos.json` as
 * transcript-sidecar archive reads.
 *
 * The fixtures build real completed executions on disk from sidecar data
 * alone, which is what a tool-use run persists, and prove that conversation
 * display, chat export, and todos all read through the facade. The
 * execution→stream mapping is the `streamId` stamped on execution metadata at
 * registration — nothing re-derives it from names, sidecar scans, or
 * suffix matching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launchMocks = vi.hoisted(() => ({
  acquireResumedExecutionLease: vi.fn(),
  buildVars: vi.fn(),
  clearTerminalExecutionState: vi.fn(),
  createHandler: vi.fn(),
  hasPersistedParent: vi.fn(),
  loadAgent: vi.fn(),
  releaseOwnedExecutionLeaseAfterFailure: vi.fn(),
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
vi.mock('@agent/utils/userVars', async (importActual) => ({
  ...(await importActual<typeof import('@agent/utils/userVars')>()),
  buildUserVars: launchMocks.buildVars,
}));
vi.mock('@agent/storage/executionLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/executionLifecycle')>()),
  clearTerminalExecutionState: launchMocks.clearTerminalExecutionState,
  hasPersistedParent: launchMocks.hasPersistedParent,
}));
vi.mock('@agent/storage/executionLease', async (importActual) => ({
  ...(await importActual<typeof import('@agent/storage/executionLease')>()),
  acquireResumedExecutionLease: launchMocks.acquireResumedExecutionLease,
  captureOwnedExecutionLease:
    (_executionId: ExecutionId) => (operation: () => unknown) =>
      operation(),
  releaseOwnedExecutionLeaseAfterFailure:
    launchMocks.releaseOwnedExecutionLeaseAfterFailure,
}));

import { clearStoreCache, getExecutionStore } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { loadChatExportInput } from '@agent/export/loadChatExportInput';
import { resumeToolUseFromResumeData } from '@agent/runtime/executeAgent';
import { resolveAndResumeStream } from '@agent/runtime/resolveAndResumeStream';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { flowKey } from '@agent/node/persistedFlow';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
  readCompletedRunTodos,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';
import type { TranscriptWriter } from '@transcript/StreamLogStore';

const tempDirs: string[] = [];

function runConfig(agent: string, model = 'deepseekproT'): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
  });
}

/** Stamp the execution→stream mapping the way registration does. */
async function stampStreamId(
  executionId: ExecutionId,
  streamId: StreamTabId,
): Promise<void> {
  await getExecutionStore(executionId).writeMeta({
    timestamp: '2026-07-07T00:00:00.000Z',
    streamId,
    identity: { kind: 'agent', agent: 'orchestrator' },
  });
}

interface StreamSeed {
  streamId: StreamTabId;
  /** Agent that ran the stream; roots run the orchestrator by default. */
  agent?: string;
  /** Set when the stream is a delegated child of another stream. */
  parent?: StreamTabId;
  /** Work-plan todos persisted alongside the run config. */
  todos?: TodoItem[];
}

/** Persist the snapshot sidecars that tie streams to an execution. */
async function seedStreams(
  executionId: ExecutionId,
  seeds: readonly StreamSeed[],
): Promise<StreamSnapshotStore> {
  const snapshots = new StreamSnapshotStore();
  for (const { streamId, agent = 'orchestrator', parent, todos } of seeds) {
    snapshotFacts(snapshots).setRunConfig(
      streamId,
      runConfig(agent),
      executionId,
    );
    if (parent) snapshotFacts(snapshots).setParentStream(streamId, parent);
    if (todos) snapshotFacts(snapshots).setTodos(streamId, todos);
  }
  await snapshots.flush();
  return snapshots;
}

type LogRow = Parameters<TranscriptWriter['append']>[0];

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

/** Persist transcript rows for one stream through the writer path. */
async function appendRows(
  streamId: StreamTabId,
  rows: readonly LogRow[],
): Promise<void> {
  const logs = await StreamLogStore.open();
  for (const row of rows) appendTranscriptEntry(logs, streamId, row);
  await logs.flush();
}

async function persistRows(
  executionId: ExecutionId,
  rowsByStream: ReadonlyMap<StreamTabId, readonly LogRow[]>,
): Promise<void> {
  const logs = await StreamLogStore.open();
  for (const [streamId, rows] of rowsByStream) {
    const writer = logs.acquireWriter(streamId, executionId);
    try {
      for (const row of rows) writer.appendSettled(row);
    } finally {
      writer.close();
    }
  }
  await logs.flush();
  for (const streamId of rowsByStream.keys()) logs.requestEviction(streamId);

  const reopened = await StreamLogStore.openReadOnly();
  for (const streamId of rowsByStream.keys()) {
    await reopened.ensureLoaded(streamId);
    expect(reopened.get(streamId)).toBeDefined();
  }
}

/** Write the sidecar fixture: transcript rows + snapshot meta/todos. */
async function writeSidecarFixture(
  executionId: ExecutionId,
  streamId: StreamTabId,
): Promise<void> {
  await seedStreams(executionId, [
    {
      streamId,
      todos: [
        { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
      ],
    },
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  it('serves conversation, chat export, and todos from the sidecars alone (projections gone)', async () => {
    const executionId = 'abc123abc123' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc123abc123' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);

    const store = getExecutionStore(executionId);
    await store.writeRunRecord(
      AgentConfigSchema.parse({
        agent: 'orchestrator',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Fix the lemma.',
      }),
    );
    await store.writeMeta({
      timestamp: '2026-07-07T00:00:00.000Z',
      streamId,
      identity: { kind: 'agent', agent: 'orchestrator' },
    });

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
            url: 'https://example.org/a',
            title: 'Sobolev notes',
            page_content: 'The Sobolev constant satisfies...',
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

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult.source).toBe('streamData');
    expect(todosResult.todos).toEqual([
      { content: 'Fix the bug', status: 'completed' },
    ]);
  });

  it('reconstructs both turns when the production resume launch reopens the canonical writer', async () => {
    const executionId = '0aa1110aa111' as ExecutionId;
    const streamId = 'orchestrator@legacyModel#0aa1110aa111' as StreamTabId;
    const config = runConfig('orchestrator');
    // The stamped id is the reproduction contract: minting from today's
    // config would produce a different (wrong) id.
    expect(getStreamTabId(config.agent, { executionId })).not.toBe(streamId);

    const snapshots = await seedStreams(executionId, [{ streamId }]);
    await stampStreamId(executionId, streamId);

    const logs = await StreamLogStore.open();
    const firstTurn = logs.acquireWriter(streamId, executionId);
    firstTurn.appendSettled(
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Prove the first lemma.' }),
    );
    firstTurn.appendSettled(
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'First proof.' }),
    );
    firstTurn.close();
    await logs.flush();
    logs.requestEviction(streamId);
    expect(logs.get(streamId)).toBeUndefined();

    const launchFailure = new Error('stop after resumed writer acquisition');
    launchMocks.acquireResumedExecutionLease.mockResolvedValue('existing');
    launchMocks.clearTerminalExecutionState.mockResolvedValue(undefined);
    launchMocks.hasPersistedParent.mockResolvedValue(false);
    launchMocks.releaseOwnedExecutionLeaseAfterFailure.mockImplementation(
      async (_executionId: ExecutionId, error: unknown) => error,
    );
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
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: persistedResumeState.shared,
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const session = createTestSession({ transcripts: logs });
    const loadAndAcquireWriter = logs.loadAndAcquireWriter.bind(logs);
    const resumedWriter = vi
      .spyOn(logs, 'loadAndAcquireWriter')
      .mockImplementationOnce(async (requestedStreamId, ownerKey) => {
        const writer = await loadAndAcquireWriter(requestedStreamId, ownerKey);
        writer.appendSettled(
          logRow(MESSAGE_TYPES.USER_MESSAGE, {
            text: 'Now prove the second lemma.',
          }),
        );
        writer.appendSettled(
          logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Second proof.' }),
        );
        return writer;
      });

    const resolveResumeState = vi.fn(async (requestedStreamId: StreamTabId) => {
      const { config: runState, executionId: resolvedExecutionId } =
        snapshots.getRunMetadata(requestedStreamId);
      return runState && resolvedExecutionId
        ? { runState, executionId: resolvedExecutionId }
        : undefined;
    });
    const reportFailure = vi.fn();
    try {
      await expect(
        resolveAndResumeStream(streamId, {
          interactions: session.interactions,
          streamStatus: session.status,
          resolveResumeState,
          resumeToolUse: async (resume) => {
            await resumeToolUseFromResumeData(resume, { session });
            return true;
          },
          executeWorkflow: vi.fn(async () => undefined),
          reportFailure,
        }),
      ).resolves.toBe(false);
    } finally {
      session.dispose();
    }
    await logs.flush();

    expect(resolveResumeState).toHaveBeenCalledWith(streamId);
    expect(reportFailure).toHaveBeenCalledWith(streamId, launchFailure);
    expect(resumedWriter).toHaveBeenCalledWith(streamId, executionId);
    expect(
      launchMocks.releaseOwnedExecutionLeaseAfterFailure,
    ).toHaveBeenCalledWith(executionId, launchFailure);
    resumedWriter.mockRestore();

    const archived = await readCompletedRunConversation(executionId);
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

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain('Conversation (4 messages)');
    expect(endpoint.output).toContain('Prove the first lemma.');
    expect(endpoint.output).toContain('First proof.');
    expect(endpoint.output).toContain('Now prove the second lemma.');
    expect(endpoint.output).toContain('Second proof.');

    const firstPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 0,
      limit: 2,
    });
    const secondPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 2,
      limit: 2,
    });
    expect(firstPage.output).toContain('Source: streamLog');
    expect(firstPage.output).toContain(`Stream: ${streamId}`);
    expect(firstPage.output).toContain('Returned message interval: [0, 2)');
    expect(firstPage.output).toContain('Next offset: 2');
    expect(firstPage.output).toContain('<message index="1"');
    expect(firstPage.output).toContain('<message index="2"');
    expect(firstPage.output).not.toContain('Now prove the second lemma.');
    expect(secondPage.output).toContain('Returned message interval: [2, 4)');
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

    const lineRange = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      view_range: [1, 10],
    });
    expect(lineRange.status).toBe('error');
    expect(lineRange.error).toContain(
      'Conversation pagination is message-based. Use offset and limit',
    );
  });

  it('treats a present empty work plan as authoritative', async () => {
    const executionId = '0aa2220aa222' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0aa2220aa222' as StreamTabId;
    await seedStreams(executionId, [{ streamId, todos: [] }]);
    await stampStreamId(executionId, streamId);
    const result = await readCompletedRunTodos(executionId);

    expect(result).toEqual({ todos: [], source: 'streamData', streamId });
  });

  it('reports none, with no conversation evidence, when metadata has no stamped stream', async () => {
    const executionId = 'ccc333ccc333' as ExecutionId;

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(false);

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult).toEqual({ todos: [], source: 'none' });

    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-07T00:00:00.000Z',
    });
    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint).toEqual({
      status: 'executed',
      output: [
        'Conversation (0 messages):',
        'Source: none',
        'Stream: none',
        'Returned message interval: [0, 0)',
        'Next offset: none',
        '',
        '',
      ].join('\n'),
    });
  });

  it('reads a registered execution without sidecar or suffix scans, even when its transcript is empty (#9590 A1)', async () => {
    const executionId = 'abc907abc907' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc907abc907' as StreamTabId;
    await stampStreamId(executionId, streamId);
    // A decoy stream that a suffix scan would match; registration must make
    // it unreachable — the stamped (empty) stream is authoritative.
    await persistRows(
      executionId,
      new Map([
        [
          `other@model#${executionId}` as StreamTabId,
          [logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'decoy row' })],
        ],
      ]),
    );

    const scan = vi.spyOn(
      StreamSnapshotStore.prototype,
      'listPersistedStreams',
    );

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({
      conversation: null,
      source: 'none',
      streamId,
    });
    // The stamped stream id alone is association evidence.
    expect(hasCompletedRunConversationEvidence(conversationResult)).toBe(true);

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult).toEqual({ todos: [], source: 'none' });

    expect(scan).not.toHaveBeenCalled();
  });

  it('reads a sidecar conversation', async () => {
    const executionId = 'ddd444ddd444' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#ddd444ddd444' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);
    await stampStreamId(executionId, streamId);
    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('streamLog');
    expect(result.streamId).toBe(streamId);
    expect(result.conversation).not.toBeNull();
    expect(result.conversation?.length).toBeGreaterThan(0);
  });

  it('reconstructs structured successful and failed tool results as model-facing text', async () => {
    const executionId = '0ee5550ee555' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0ee5550ee555' as StreamTabId;
    await seedStreams(executionId, [{ streamId }]);
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

  it('preserves a diagnostic-only stamped stream as execution evidence without a conversation', async () => {
    const executionId = '0999cb0999cb' as ExecutionId;
    const root = 'orchestrator@model#0999cb0999cb' as StreamTabId;
    await seedStreams(executionId, [{ streamId: root }]);
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

  it('never substitutes another stream for an empty stamped stream', async () => {
    const executionId = '0999cc0999cc' as ExecutionId;
    const root = 'orchestrator@model#0999cc0999cc' as StreamTabId;
    const child = 'child@tool#0999cc0999cc' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: root },
      { streamId: child, agent: 'bash', parent: root },
    ]);
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

  it('reads a historical execution whose stamped stream uses the tool-format child id', async () => {
    const executionId = '0999cd0999cd' as ExecutionId;
    const streamId = 'child@tool#0999cd0999cd' as StreamTabId;
    const parentStreamId = 'orchestrator@model#parent' as StreamTabId;
    await seedStreams(executionId, [
      { streamId, agent: 'bash', parent: parentStreamId },
    ]);
    await stampStreamId(executionId, streamId);

    await appendRows(streamId, [
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Delegated question' }),
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Delegated answer' }),
    ]);

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId,
      conversation: [
        { role: 'user', content: 'Delegated question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Delegated answer' }],
        },
      ],
    });
  });
});
