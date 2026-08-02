/**
 * Completed-run archive facade (#7246 Decision 1): the transcript sidecars
 * own completed-run display/export, with `executions/{id}/conversation.json`
 * / `todos.json` as read-only legacy fallbacks.
 *
 * Cross-module scenario (stated in the PR body): the fixture below builds a
 * real completed execution on disk with ONLY sidecar data — no
 * `conversation.json` / `todos.json` projections, matching what tool-use
 * runs persist now that the per-step projection writes are deleted — and
 * proves conversation display, chat export, and todos all read through the
 * facade.
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
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import {
  readCompletedRunConversation,
  readCompletedRunTodos,
  seedResumedConversationSidecar,
  StreamLogStore,
  StreamSnapshotStore,
} from '@transcript';

const tempDirs: string[] = [];

function runConfig(agent: string, model = 'deepseekproT'): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
  });
}

let entryCounter = 0;

function logRow(
  messageType: string,
  fields: { text?: string; data?: unknown },
): Parameters<StreamLogStore['append']>[1] {
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

async function persistRows(
  executionId: ExecutionId,
  rowsByStream: ReadonlyMap<
    StreamTabId,
    readonly Parameters<StreamLogStore['append']>[1][]
  >,
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
  const snapshots = new StreamSnapshotStore();
  snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
  snapshots.setTodos(streamId, [
    { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
  ]);
  await snapshots.flush();

  const logs = await StreamLogStore.open();
  logs.ensureStream(streamId);
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Fix the lemma.',
      data: { attachments: ['image'] },
    }),
  );
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.THINKING, {
      text: 'Consider the boundary terms.',
    }),
  );
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.WEB_SEARCH, {
      data: {
        query: 'sobolev constant',
        results: [{ url: 'https://example.org/a', title: 'Sobolev notes' }],
        provider: 'anthropic',
        status: 'completed',
      },
    }),
  );
  logs.append(
    streamId,
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
  );
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.TOOL_USE, {
      data: {
        toolName: 'write_file',
        input: { path: 'notes/lemma.tex' },
        output: 'File written.',
        status: 'completed',
      },
    }),
  );
  // Diagnostic row: deliberately skipped by the mapper (never lived in the
  // legacy conversation.json projection either).
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.STATISTICS, {
      text: 'Usage - input: 10, output: 5',
      data: { inputTokens: 10, outputTokens: 5 },
    }),
  );
  logs.append(
    streamId,
    logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Done - the lemma is fixed.',
    }),
  );
  await logs.flush();
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
    await store.writeConfig(
      AgentConfigSchema.parse({
        agent: 'orchestrator',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        instruction: 'Fix the lemma.',
      }),
    );
    await store.writeMeta({
      timestamp: '2026-07-07T00:00:00.000Z',
      terminalStatus: 'completed',
    });

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult.source).toBe('streamLog');
    expect(conversationResult.streamId).toBe(streamId);
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
    expect(
      getStreamTabId(config.agent, config.model, { executionId }),
    ).not.toBe(streamId);

    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(streamId, config, executionId);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.ensureStream(streamId);
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
      definitionPath: '/agents/orchestrator.yaml',
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
      const runState = snapshots.getRunConfig(requestedStreamId);
      const resolvedExecutionId = snapshots.getExecutionId(requestedStreamId);
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

  it('falls back to the legacy KV projections when no sidecar exists', async () => {
    const executionId = 'bbb222bbb222' as ExecutionId;
    const store = getExecutionStore(executionId);
    await store.write('conversation', [
      { role: 'user', content: 'Legacy question' },
      { role: 'assistant', content: 'Legacy answer' },
    ]);
    await store.write('todos', [{ content: 'Legacy todo', status: 'pending' }]);

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult.source).toBe('legacyKV');
    expect(conversationResult.conversation).toEqual([
      { role: 'user', content: 'Legacy question' },
      { role: 'assistant', content: 'Legacy answer' },
    ]);

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult.source).toBe('legacyKV');
    expect(todosResult.todos).toEqual([
      { content: 'Legacy todo', status: 'pending' },
    ]);
  });

  it('treats a present empty work plan as authoritative over stale legacy todos', async () => {
    const executionId = '0aa2220aa222' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0aa2220aa222' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
    snapshots.setTodos(streamId, []);
    await snapshots.flush();
    await getExecutionStore(executionId).write('todos', [
      { content: 'Stale legacy todo', status: 'pending' },
    ]);

    const result = await readCompletedRunTodos(executionId);

    expect(result).toEqual({ todos: [], source: 'streamData', streamId });
  });

  it('reports none when neither the sidecar nor the legacy projection has data', async () => {
    const executionId = 'ccc333ccc333' as ExecutionId;

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult).toEqual({ todos: [], source: 'none' });

    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-07T00:00:00.000Z',
      terminalStatus: 'completed',
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

  it('prefers the sidecar when a legacy conversation projection also exists', async () => {
    const executionId = 'ddd444ddd444' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#ddd444ddd444' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);
    await getExecutionStore(executionId).write('conversation', [
      { role: 'assistant', content: 'Legacy projection' },
    ]);

    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('streamLog');
    expect(result.streamId).toBe(streamId);
    expect(result.conversation).not.toContainEqual({
      role: 'assistant',
      content: 'Legacy projection',
    });
  });

  it('seeds a resumed legacy conversation into an empty transcript once', async () => {
    const executionId = '0dd4440dd444' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0dd4440dd444' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.ensureStream(streamId);
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Resuming...' }),
    );
    const messages = [
      { role: 'system', content: 'Follow the proof protocol.' },
      { role: 'user', content: 'Prove the legacy lemma.' },
      { role: 'assistant', content: 'Here is the legacy proof.' },
    ];

    await expect(
      seedResumedConversationSidecar(logs, streamId, executionId, messages),
    ).resolves.toBe(true);
    await expect(
      seedResumedConversationSidecar(logs, streamId, executionId, [
        { role: 'assistant', content: 'Duplicate seed' },
      ]),
    ).resolves.toBe(false);
    await logs.flush();

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      source: 'streamLog',
      streamId,
      conversation: [
        { role: 'system', content: 'Follow the proof protocol.' },
        { role: 'user', content: 'Prove the legacy lemma.' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is the legacy proof.' }],
        },
      ],
    });
  });

  it('reconstructs structured successful and failed tool results as model-facing text', async () => {
    const executionId = '0ee5550ee555' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0ee5550ee555' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.ensureStream(streamId);
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.TOOL_USE, {
        data: {
          toolName: 'write_file',
          input: { path: 'proof.tex' },
          output: { output: 'File written.' },
          status: 'completed',
        },
      }),
    );
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.TOOL_USE, {
        data: {
          toolName: 'read_file',
          input: { path: 'missing.tex' },
          output: { error: 'File not found.' },
          isError: true,
          status: 'failed',
        },
      }),
    );
    await logs.flush();

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

  it('never lets an empty-but-present legacy file beat a full sidecar (non-empty rule)', async () => {
    const executionId = 'fff666fff666' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#fff666fff666' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);
    await getExecutionStore(executionId).write('conversation', []);

    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('streamLog');
    expect(result.streamId).toBe(streamId);
    expect(result.conversation).not.toBeNull();
    expect(result.conversation!.length).toBeGreaterThan(0);
  });

  it('reads the historical root instead of its child sidecar', async () => {
    const executionId = '0777aa0777aa' as ExecutionId;
    const emptyStream = 'aChild@tool#0777aa0777aa' as StreamTabId;
    const fullStream = 'zOrchestrator@deepseekproT#0777aa0777aa' as StreamTabId;

    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(emptyStream, runConfig('bash'), executionId);
    snapshots.setRunConfig(fullStream, runConfig('orchestrator'), executionId);
    snapshots.setParentStream(emptyStream, fullStream);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.ensureStream(emptyStream);
    logs.append(
      emptyStream,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Working...' }),
    );
    logs.ensureStream(fullStream);
    logs.append(
      fullStream,
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Real question' }),
    );
    logs.append(
      fullStream,
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Real answer' }),
    );
    await logs.flush();

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      source: 'streamLog',
      streamId: fullStream,
      conversation: [
        { role: 'user', content: 'Real question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Real answer' }],
        },
      ],
    });
  });

  it('does not merge a disjoint exact-execution sidecar with missing parent metadata', async () => {
    const executionId = '0888ba0888ba' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888ba0888ba' as StreamTabId;
    const ambiguousChild = 'zOrchestrator@new#0888ba0888ba' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(canonical, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(
      ambiguousChild,
      runConfig('orchestrator'),
      executionId,
    );
    await snapshots.flush();

    await persistRows(
      executionId,
      new Map([
        [
          canonical,
          [
            {
              ...logRow(MESSAGE_TYPES.USER_MESSAGE, {
                text: 'Canonical question',
              }),
              timestamp: 9000,
            },
          ],
        ],
        [
          ambiguousChild,
          [
            {
              ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
                text: 'Unproven child answer',
              }),
              // A reversed clock cannot order a disconnected sidecar.
              timestamp: 1000,
            },
          ],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId: canonical,
      candidateStreamIds: [ambiguousChild],
      conversation: [{ role: 'user', content: 'Canonical question' }],
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain(
      `Ambiguous candidate streams: ${ambiguousChild}`,
    );
    expect(endpoint.output).not.toContain('Unproven child answer');
  });

  it('reports conflicting copied text, role, and status instead of silently deduplicating', async () => {
    const executionId = '0888bd0888bd' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888bd0888bd' as StreamTabId;
    const conflicting = 'zOrchestrator@new#0888bd0888bd' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(canonical, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(conflicting, runConfig('orchestrator'), executionId);
    await snapshots.flush();

    const copiedText = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Canonical answer' }),
      id: 'copied-text',
    };
    const copiedRole = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, {
        text: 'Role-sensitive prompt',
        data: { archivedRole: 'user' },
      }),
      id: 'copied-role',
    };
    const copiedStatus = {
      ...logRow(MESSAGE_TYPES.TOOL_USE, {
        data: {
          toolName: 'read_file',
          input: { path: 'proof.tex' },
          output: 'Proof text',
          status: 'completed',
        },
      }),
      id: 'copied-status',
    };
    await persistRows(
      executionId,
      new Map([
        [canonical, [copiedText, copiedRole, copiedStatus]],
        [
          conflicting,
          [
            { ...copiedText, text: 'Conflicting answer' },
            { ...copiedRole, data: { archivedRole: 'system' } },
            {
              ...copiedStatus,
              data: {
                toolName: 'read_file',
                input: { path: 'proof.tex' },
                output: 'Proof text',
                status: 'failed',
              },
            },
          ],
        ],
      ]),
    );

    const result = await readCompletedRunConversation(executionId);
    expect(result).toMatchObject({
      source: 'streamLog',
      streamId: canonical,
      candidateStreamIds: [conflicting],
      conflicts: [
        { rowId: 'copied-role', streamIds: [canonical, conflicting] },
        { rowId: 'copied-status', streamIds: [canonical, conflicting] },
        { rowId: 'copied-text', streamIds: [canonical, conflicting] },
      ],
    });
    expect(result.conversation).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Canonical answer' }],
    });
    expect(JSON.stringify(result.conversation)).not.toContain(
      'Conflicting answer',
    );

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain(
      'Conflicting row IDs: copied-role, copied-status, copied-text',
    );
  });

  it('merges matched roots, excluding children and only deduplicating row identity', async () => {
    const executionId = '0888bb0888bb' as ExecutionId;
    const firstRoot = 'aOrchestrator@old#0888bb0888bb' as StreamTabId;
    const secondRoot = 'bOrchestrator@new#0888bb0888bb' as StreamTabId;
    const child = 'child@tool#0888bb0888bb' as StreamTabId;

    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(firstRoot, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(secondRoot, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(child, runConfig('bash'), executionId);
    snapshots.setParentStream(child, firstRoot);
    await snapshots.flush();

    const firstQuestion = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'First question' }),
      timestamp: 2000,
    };
    const firstAnswer = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'First answer' }),
      // A clock adjustment must not move this response before its prompt.
      timestamp: 1000,
    };
    const secondQuestion = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Second question' }),
      timestamp: 3000,
    };
    const secondAnswer = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
        // Equal text with a distinct row identity is a real second message.
        text: 'First answer',
      }),
      timestamp: 4000,
    };
    const childMessage = logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Child implementation detail',
    });

    const logs = await StreamLogStore.open();
    logs.append(firstRoot, firstQuestion);
    logs.append(firstRoot, firstAnswer);
    // The resumed sidecar copied the last settled row before appending turn 2.
    logs.append(secondRoot, firstAnswer);
    logs.append(secondRoot, secondQuestion);
    logs.append(secondRoot, secondAnswer);
    logs.append(child, childMessage);
    await logs.flush();

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      source: 'streamLog',
      streamId: firstRoot,
      streamIds: [firstRoot, secondRoot],
      conversation: [
        { role: 'user', content: 'First question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'First answer' }],
        },
        { role: 'user', content: 'Second question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'First answer' }],
        },
      ],
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain(
      `Merged streams: ${firstRoot}, ${secondRoot}`,
    );
    expect(endpoint.output).not.toContain('Child implementation detail');
    expect(endpoint.output?.split('First answer')).toHaveLength(3);
  });

  it('retains copied rows as ordering constraints across roots', async () => {
    const executionId = '0888bc0888bc' as ExecutionId;
    const firstRoot = 'orchestrator@old#0888bc0888bc' as StreamTabId;
    const resumedRoot = 'orchestrator@new#0888bc0888bc' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(firstRoot, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(resumedRoot, runConfig('orchestrator'), executionId);
    await snapshots.flush();

    const copiedQuestion = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Copied question' }),
      timestamp: 2000,
    };
    const answer = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Later answer' }),
      // The copied prompt still constrains this row despite the earlier clock.
      timestamp: 1000,
    };
    const logs = await StreamLogStore.open();
    logs.append(firstRoot, copiedQuestion);
    logs.append(resumedRoot, copiedQuestion);
    logs.append(resumedRoot, answer);
    await logs.flush();

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId: resumedRoot,
      streamIds: [resumedRoot, firstRoot],
      conversation: [
        { role: 'user', content: 'Copied question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Later answer' }],
        },
      ],
    });
  });

  it('merges transitive overlaps while reporting a disconnected candidate across pages', async () => {
    const executionId = '0888be0888be' as ExecutionId;
    const streams = ['a', 'b', 'c', 'd', 'z'].map(
      (name) => `orchestrator@${name}#0888be0888be` as StreamTabId,
    );
    const [streamA, streamB, streamC, streamD, disconnected] = streams;
    const snapshots = new StreamSnapshotStore();
    for (const streamId of streams) {
      snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
    }
    await snapshots.flush();

    const rows = ['A', 'B', 'C', 'D', 'E'].map((text) => ({
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text }),
      id: `transitive-${text.toLowerCase()}`,
    }));
    const disconnectedRow = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Disconnected' }),
      timestamp: 1,
    };
    await persistRows(
      executionId,
      new Map([
        [streamA, [rows[0], rows[1]]],
        [streamB, [rows[1], rows[2]]],
        [streamC, [rows[2], rows[3]]],
        [streamD, [rows[3], rows[4]]],
        [disconnected, [disconnectedRow]],
      ]),
    );

    const archived = await readCompletedRunConversation(executionId);
    expect(archived).toEqual({
      source: 'streamLog',
      streamId: streamA,
      streamIds: [streamA, streamB, streamC, streamD],
      candidateStreamIds: [disconnected],
      conversation: ['A', 'B', 'C', 'D', 'E'].map((content) => ({
        role: 'user',
        content,
      })),
    });

    const firstPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 0,
      limit: 2,
    });
    const secondPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 2,
      limit: 3,
    });
    for (const page of [firstPage, secondPage]) {
      expect(page.output).toContain(
        `Merged streams: ${streamA}, ${streamB}, ${streamC}, ${streamD}`,
      );
      expect(page.output).toContain(
        `Ambiguous candidate streams: ${disconnected}`,
      );
      expect(page.output).not.toContain('Disconnected');
    }
    const pagedOutput = `${firstPage.output}\n${secondPage.output}`;
    for (const text of ['A', 'B', 'C', 'D', 'E']) {
      expect(pagedOutput.split(`\n${text}\n</message>`)).toHaveLength(2);
    }
  });

  it('merges a valid overlap component despite a disconnected conflicting candidate', async () => {
    const executionId = '0888b60888b6' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b60888b6' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b60888b6' as StreamTabId;
    const conflicting = 'cOrchestrator@other#0888b60888b6' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    for (const streamId of [canonical, continuation, conflicting]) {
      snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
    }
    await snapshots.flush();

    const prefix = logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Prefix' });
    const copied = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Shared answer' }),
      id: 'shared-conflict-row',
    };
    const continued = logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Valid continuation',
    });
    await persistRows(
      executionId,
      new Map([
        [canonical, [prefix, copied]],
        [continuation, [copied, continued]],
        [conflicting, [{ ...copied, text: 'Incompatible copy' }]],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId: canonical,
      streamIds: [canonical, continuation],
      candidateStreamIds: [conflicting],
      conflicts: [
        {
          rowId: 'shared-conflict-row',
          streamIds: [canonical, continuation, conflicting],
        },
      ],
      conversation: [
        { role: 'user', content: 'Prefix' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Shared answer' }],
        },
        { role: 'user', content: 'Valid continuation' },
      ],
    });
  });

  it('falls back when acyclic overlap constraints do not establish unique chronology', async () => {
    const executionId = '0888b70888b7' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b70888b7' as StreamTabId;
    const ambiguous = 'bOrchestrator@new#0888b70888b7' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(canonical, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(ambiguous, runConfig('orchestrator'), executionId);
    await snapshots.flush();

    const shared = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Shared prompt' }),
      id: 'ambiguous-shared',
    };
    const canonicalSuccessor = logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Canonical branch',
    });
    const ambiguousSuccessor = logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Ambiguous branch',
    });
    await persistRows(
      executionId,
      new Map([
        [canonical, [shared, canonicalSuccessor]],
        [ambiguous, [shared, ambiguousSuccessor]],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId: canonical,
      candidateStreamIds: [ambiguous],
      hasOrderingAmbiguity: true,
      conversation: [
        { role: 'user', content: 'Shared prompt' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Canonical branch' }],
        },
      ],
    });

    const firstPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 0,
      limit: 1,
    });
    const secondPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 1,
      limit: 1,
    });
    for (const page of [firstPage, secondPage]) {
      expect(page.output).toContain('Complete chronology established: no');
      expect(page.output).toContain(
        `Ambiguous candidate streams: ${ambiguous}`,
      );
      expect(page.output).not.toContain('Ambiguous branch');
    }
    expect(firstPage.output).toContain('Returned message interval: [0, 1)');
    expect(secondPage.output).toContain('Returned message interval: [1, 2)');
  });

  it('ignores non-conversation branches when the message order is unique', async () => {
    const executionId = '0888b80888b8' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b80888b8' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b80888b8' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(canonical, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(
      continuation,
      runConfig('orchestrator'),
      executionId,
    );
    await snapshots.flush();

    const shared = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Shared prompt' }),
      id: 'diagnostic-branch-shared',
    };
    const answer = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Shared answer' }),
      id: 'diagnostic-branch-answer',
    };
    const nextTurn = logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Continued question',
    });
    await persistRows(
      executionId,
      new Map([
        [
          canonical,
          [
            shared,
            logRow(MESSAGE_TYPES.PROGRESS_STATUS, {
              text: 'Canonical status',
            }),
            answer,
          ],
        ],
        [
          continuation,
          [
            shared,
            logRow(MESSAGE_TYPES.STATISTICS, {
              text: 'Continuation statistics',
            }),
            answer,
            nextTurn,
          ],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId: canonical,
      streamIds: [canonical, continuation],
      conversation: [
        { role: 'user', content: 'Shared prompt' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Shared answer' }],
        },
        { role: 'user', content: 'Continued question' },
      ],
    });
  });

  it('keeps the selected archive when copied-row ordering forms a cycle', async () => {
    const executionId = '0888bf0888bf' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888bf0888bf' as StreamTabId;
    const contradictory = 'bOrchestrator@new#0888bf0888bf' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(canonical, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(
      contradictory,
      runConfig('orchestrator'),
      executionId,
    );
    await snapshots.flush();

    const first = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'First' }),
      id: 'cycle-first',
    };
    const second = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Second' }),
      id: 'cycle-second',
    };
    await persistRows(
      executionId,
      new Map([
        [canonical, [first, second]],
        [contradictory, [second, first]],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamId: canonical,
      candidateStreamIds: [contradictory],
      hasOrderingCycle: true,
      conversation: [
        { role: 'user', content: 'First' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Second' }],
        },
      ],
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain('Ordering cycle detected: yes');
    expect(endpoint.output).not.toContain('Merged streams:');
  });

  it('never substitutes child conversation rows for empty confirmed roots', async () => {
    const executionId = '0999cc0999cc' as ExecutionId;
    const root = 'orchestrator@model#0999cc0999cc' as StreamTabId;
    const child = 'child@tool#0999cc0999cc' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(root, runConfig('orchestrator'), executionId);
    snapshots.setRunConfig(child, runConfig('bash'), executionId);
    snapshots.setParentStream(child, root);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.append(
      root,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Root status only' }),
    );
    logs.append(
      child,
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Child-only prompt' }),
    );
    logs.append(
      child,
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Child-only answer' }),
    );
    await logs.flush();

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      conversation: null,
      source: 'none',
    });
  });

  it('reads a historical execution whose canonical stream is delegated', async () => {
    const executionId = '0999cd0999cd' as ExecutionId;
    const streamId = 'child@tool#0999cd0999cd' as StreamTabId;
    const parentStreamId = 'orchestrator@model#parent' as StreamTabId;
    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(streamId, runConfig('bash'), executionId);
    snapshots.setParentStream(streamId, parentStreamId);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Delegated question' }),
    );
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Delegated answer' }),
    );
    await logs.flush();

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

  it('falls back to legacy when the transcript holds no conversation-shaped rows', async () => {
    const executionId = 'eee555eee555' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#eee555eee555' as StreamTabId;

    const snapshots = new StreamSnapshotStore();
    snapshots.setRunConfig(streamId, runConfig('orchestrator'), executionId);
    await snapshots.flush();

    const logs = await StreamLogStore.open();
    logs.ensureStream(streamId);
    logs.append(
      streamId,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Working...' }),
    );
    await logs.flush();

    await getExecutionStore(executionId).write('conversation', [
      { role: 'user', content: 'Pre-sidecar conversation' },
    ]);
    // The sidecar exists but reconstructs to zero messages, so the historical
    // read fallback remains available.

    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('legacyKV');
    expect(result.conversation).toEqual([
      { role: 'user', content: 'Pre-sidecar conversation' },
    ]);
  });
});
