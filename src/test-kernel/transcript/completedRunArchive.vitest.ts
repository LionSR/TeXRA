/**
 * Completed-run archive facade: the transcript sidecars own completed-run
 * display/export, with `executions/{id}/conversation.json` / `todos.json` as
 * transcript-sidecar archive reads.
 *
 * The fixtures build real completed executions on disk from sidecar data
 * alone, which is what a tool-use run persists, and prove that conversation
 * display, chat export, and todos all read through the facade.
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
  EXECUTION_STREAM_ID_SOURCE,
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
  await seedStreams(executionId, [
    {
      streamId,
      todos: [
        { content: 'Fix the bug', status: 'completed', activeForm: 'Fixing' },
      ],
    },
  ]);

  const logs = await StreamLogStore.open();
  logs.ensureStream(streamId);
  appendTranscriptEntry(
    logs,
    streamId,
    logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Fix the lemma.',
      data: { attachments: ['image'] },
    }),
  );
  appendTranscriptEntry(
    logs,
    streamId,
    logRow(MESSAGE_TYPES.THINKING, {
      text: 'Consider the boundary terms.',
    }),
  );
  appendTranscriptEntry(
    logs,
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
  appendTranscriptEntry(
    logs,
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
  appendTranscriptEntry(
    logs,
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
  appendTranscriptEntry(
    logs,
    streamId,
    logRow(MESSAGE_TYPES.STATISTICS, {
      text: 'Usage - input: 10, output: 5',
      data: { inputTokens: 10, outputTokens: 5 },
    }),
  );
  appendTranscriptEntry(
    logs,
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

    const snapshots = await seedStreams(executionId, [{ streamId }]);

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

  it('treats a present empty work plan as authoritative', async () => {
    const executionId = '0aa2220aa222' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0aa2220aa222' as StreamTabId;
    await seedStreams(executionId, [{ streamId, todos: [] }]);
    const result = await readCompletedRunTodos(executionId);

    expect(result).toEqual({ todos: [], source: 'streamData', streamId });
  });

  it('reports none when no sidecar has data', async () => {
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

  it('reads a registered execution without sidecar or suffix scans, even when its transcript is empty (#9590 A1)', async () => {
    const executionId = 'abc907abc907' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#abc907abc907' as StreamTabId;
    await getExecutionStore(executionId).writeMeta({
      timestamp: '2026-07-07T00:00:00.000Z',
      terminalStatus: 'completed',
      streamId,
      streamIdSource: EXECUTION_STREAM_ID_SOURCE.REGISTRATION,
    });
    // A decoy stream that a suffix scan would match; registration must make
    // it unreachable, and an empty registered transcript must not trigger the
    // alternate-root fallback scan.
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
    const association = vi.spyOn(
      StreamSnapshotStore.prototype,
      'readPersistedStreamAssociation',
    );

    const conversationResult = await readCompletedRunConversation(executionId);
    expect(conversationResult).toEqual({ conversation: null, source: 'none' });

    const todosResult = await readCompletedRunTodos(executionId);
    expect(todosResult).toEqual({ todos: [], source: 'none' });

    expect(scan).not.toHaveBeenCalled();
    expect(association).not.toHaveBeenCalled();
  });

  it('reads a sidecar conversation', async () => {
    const executionId = 'ddd444ddd444' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#ddd444ddd444' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);
    const result = await readCompletedRunConversation(executionId);
    expect(result.source).toBe('streamLog');
    expect(result.streamId).toBe(streamId);
    expect(result.conversation).not.toBeNull();
  });

  it('seeds a resumed legacy conversation into an empty transcript once', async () => {
    const executionId = '0dd4440dd444' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#0dd4440dd444' as StreamTabId;
    await seedStreams(executionId, [{ streamId }]);

    const logs = await StreamLogStore.open();
    logs.ensureStream(streamId);
    appendTranscriptEntry(
      logs,
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
    await seedStreams(executionId, [{ streamId }]);

    const logs = await StreamLogStore.open();
    logs.ensureStream(streamId);
    appendTranscriptEntry(
      logs,
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
    appendTranscriptEntry(
      logs,
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

  it('reads a full sidecar', async () => {
    const executionId = 'fff666fff666' as ExecutionId;
    const streamId = 'orchestrator@deepseekproT#fff666fff666' as StreamTabId;
    await writeSidecarFixture(executionId, streamId);
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

    await seedStreams(executionId, [
      { streamId: emptyStream, agent: 'bash', parent: fullStream },
      { streamId: fullStream },
    ]);

    const logs = await StreamLogStore.open();
    logs.ensureStream(emptyStream);
    appendTranscriptEntry(
      logs,
      emptyStream,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Working...' }),
    );
    logs.ensureStream(fullStream);
    appendTranscriptEntry(
      logs,
      fullStream,
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Real question' }),
    );
    appendTranscriptEntry(
      logs,
      fullStream,
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Real answer' }),
    );
    await logs.flush();

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      source: 'streamLog',
      streamId: fullStream,
      associatedStreamIds: [emptyStream],
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
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: ambiguousChild },
    ]);

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
      source: 'none',
      candidateStreamIds: [canonical, ambiguousChild],
      conversation: null,
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain('Source: none');
    expect(endpoint.output).toContain('Stream: none');
    expect(endpoint.output).toContain(
      `Ambiguous candidate streams: ${canonical}, ${ambiguousChild}`,
    );
    expect(endpoint.output).not.toContain('Canonical question');
    expect(endpoint.output).not.toContain('Unproven child answer');
  });

  it('reports conflicting copied text, role, and status instead of silently deduplicating', async () => {
    const executionId = '0888bd0888bd' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888bd0888bd' as StreamTabId;
    const conflicting = 'zOrchestrator@new#0888bd0888bd' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: conflicting },
    ]);

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
    const copiedTimestamp = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Timed answer' }),
      id: 'copied-timestamp',
      timestamp: 1000,
    };
    await persistRows(
      executionId,
      new Map([
        [canonical, [copiedText, copiedRole, copiedStatus, copiedTimestamp]],
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
            { ...copiedTimestamp, timestamp: 2000 },
          ],
        ],
      ]),
    );

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      source: 'none',
      conversation: null,
      candidateStreamIds: [canonical, conflicting],
      conflicts: [
        { rowId: 'copied-role', streamIds: [canonical, conflicting] },
        { rowId: 'copied-status', streamIds: [canonical, conflicting] },
        { rowId: 'copied-text', streamIds: [canonical, conflicting] },
        { rowId: 'copied-timestamp', streamIds: [canonical, conflicting] },
      ],
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain(
      'Conflicting row IDs: copied-role, copied-status, copied-text, copied-timestamp',
    );
  });

  it('merges matched roots, excluding children and only deduplicating row identity', async () => {
    const executionId = '0888bb0888bb' as ExecutionId;
    const firstRoot = 'aOrchestrator@old#0888bb0888bb' as StreamTabId;
    const secondRoot = 'bOrchestrator@new#0888bb0888bb' as StreamTabId;
    const child = 'child@tool#0888bb0888bb' as StreamTabId;

    await seedStreams(executionId, [
      { streamId: firstRoot },
      { streamId: secondRoot },
      { streamId: child, agent: 'bash', parent: firstRoot },
    ]);

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
    appendTranscriptEntry(logs, firstRoot, firstQuestion);
    appendTranscriptEntry(logs, firstRoot, firstAnswer);
    // The resumed sidecar copied the last settled row before appending turn 2.
    appendTranscriptEntry(logs, secondRoot, firstAnswer);
    appendTranscriptEntry(logs, secondRoot, secondQuestion);
    appendTranscriptEntry(logs, secondRoot, secondAnswer);
    appendTranscriptEntry(logs, child, childMessage);
    await logs.flush();

    const result = await readCompletedRunConversation(executionId);
    expect(result).toEqual({
      source: 'streamLog',
      streamIds: [firstRoot, secondRoot],
      associatedStreamIds: [child],
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
    await seedStreams(executionId, [
      { streamId: firstRoot },
      { streamId: resumedRoot },
    ]);

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
    appendTranscriptEntry(logs, firstRoot, copiedQuestion);
    appendTranscriptEntry(logs, resumedRoot, copiedQuestion);
    appendTranscriptEntry(logs, resumedRoot, answer);
    await logs.flush();

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
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

  it('does not choose an overlap component when another exact candidate is disconnected', async () => {
    const executionId = '0888be0888be' as ExecutionId;
    const streams = ['a', 'b', 'c', 'd', 'z'].map(
      (name) => `orchestrator@${name}#0888be0888be` as StreamTabId,
    );
    const [streamA, streamB, streamC, streamD, disconnected] = streams;
    await seedStreams(
      executionId,
      streams.map((streamId) => ({ streamId })),
    );

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
      source: 'none',
      candidateStreamIds: streams,
      conversation: null,
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 200,
      limit: 2,
    });
    expect(endpoint.output).toContain(
      `Ambiguous candidate streams: ${streams.join(', ')}`,
    );
    expect(endpoint.output).toContain('Returned message interval: [0, 0)');
    expect(endpoint.output).not.toContain('Merged streams:');
    expect(endpoint.output).not.toContain('Disconnected');
  });

  it('reports overlap conflicts without selecting an unproven component', async () => {
    const executionId = '0888b60888b6' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b60888b6' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b60888b6' as StreamTabId;
    const conflicting = 'cOrchestrator@other#0888b60888b6' as StreamTabId;
    await seedStreams(
      executionId,
      [canonical, continuation, conflicting].map((streamId) => ({ streamId })),
    );

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
      source: 'none',
      conversation: null,
      candidateStreamIds: [canonical, continuation, conflicting],
      conflicts: [
        {
          rowId: 'shared-conflict-row',
          streamIds: [canonical, continuation, conflicting],
        },
      ],
    });
  });

  it('ignores divergent diagnostic rows when conversation chronology has one continuation', async () => {
    const executionId = '0888b80888b8' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b80888b8' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b80888b8' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: continuation },
    ]);

    const shared = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Shared prompt' }),
      id: 'diagnostic-shared-prompt',
    };
    const answer = logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'Unique continuation',
    });
    await persistRows(
      executionId,
      new Map([
        [
          canonical,
          [
            shared,
            logRow(MESSAGE_TYPES.STATISTICS, {
              text: 'Usage - input: 10, output: 5',
            }),
          ],
        ],
        [
          continuation,
          [
            shared,
            logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Resuming...' }),
            answer,
          ],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamIds: [canonical, continuation],
      conversation: [
        { role: 'user', content: 'Shared prompt' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Unique continuation' }],
        },
      ],
    });
  });

  it('ignores divergent diagnostics that reconverge around one conversation chronology across pages', async () => {
    const executionId = '0888b90888b9' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b90888b9' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b90888b9' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: continuation },
    ]);

    const prompt = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Reconverged prompt' }),
      id: 'reconverged-prompt',
    };
    const answer = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Reconverged answer' }),
      id: 'reconverged-answer',
    };
    const followUp = logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Later unique turn',
    });
    await persistRows(
      executionId,
      new Map([
        [
          canonical,
          [
            prompt,
            logRow(MESSAGE_TYPES.STATISTICS, { text: 'Usage branch A' }),
            answer,
          ],
        ],
        [
          continuation,
          [
            prompt,
            logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Branch B' }),
            answer,
            followUp,
          ],
        ],
      ]),
    );

    const archived = await readCompletedRunConversation(executionId);
    expect(archived).toEqual({
      source: 'streamLog',
      streamIds: [canonical, continuation],
      conversation: [
        { role: 'user', content: 'Reconverged prompt' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reconverged answer' }],
        },
        { role: 'user', content: 'Later unique turn' },
      ],
    });

    const firstPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 0,
      limit: 2,
    });
    const secondPage = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
      offset: 2,
      limit: 1,
    });
    for (const page of [firstPage, secondPage]) {
      expect(page.output).toContain(
        `Merged streams: ${canonical}, ${continuation}`,
      );
      expect(page.output).not.toContain('Complete chronology established: no');
      expect(page.output).not.toContain('Ordering cycle detected: yes');
      expect(page.output).not.toContain('Usage branch A');
      expect(page.output).not.toContain('Branch B');
    }
    expect(firstPage.output).toContain('Returned message interval: [0, 2)');
    expect(firstPage.output).toContain('Next offset: 2');
    expect(secondPage.output).toContain('Returned message interval: [2, 3)');
    expect(secondPage.output).toContain('Next offset: none');
  });

  it('reports divergent diagnostic payloads without vetoing a unique conversation merge', async () => {
    const executionId = '0888b00888b0' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b00888b0' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b00888b0' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: continuation },
    ]);

    const prompt = {
      ...logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Payload prompt' }),
      id: 'payload-prompt',
    };
    const answer = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Payload answer' }),
      id: 'payload-answer',
    };
    const statistics = {
      ...logRow(MESSAGE_TYPES.STATISTICS, {
        text: 'Usage branch A',
        data: { inputTokens: 10 },
      }),
      id: 'divergent-statistics',
    };
    const followUp = logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Payload continuation',
    });
    await persistRows(
      executionId,
      new Map([
        [canonical, [prompt, statistics, answer]],
        [
          continuation,
          [
            prompt,
            {
              ...statistics,
              text: 'Usage branch B',
              data: { inputTokens: 20 },
            },
            answer,
            followUp,
          ],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamIds: [canonical, continuation],
      conflicts: [
        {
          rowId: 'divergent-statistics',
          streamIds: [canonical, continuation],
        },
      ],
      conversation: [
        { role: 'user', content: 'Payload prompt' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Payload answer' }],
        },
        { role: 'user', content: 'Payload continuation' },
      ],
    });
  });

  it('keeps incompatible copied diagnostics distinct while ordering conversation rows', async () => {
    const executionId = '0888b20888b2' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b20888b2' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b20888b2' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: continuation },
    ]);

    const first = logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'First turn' });
    const shared = {
      ...logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Shared turn' }),
      id: 'shared-conversation-row',
    };
    const diagnostic = {
      ...logRow(MESSAGE_TYPES.STATISTICS, {
        text: 'Usage branch A',
        data: { inputTokens: 10 },
      }),
      id: 'incompatible-diagnostic-row',
    };
    const last = logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Last turn' });
    await persistRows(
      executionId,
      new Map([
        [canonical, [first, diagnostic, shared]],
        [
          continuation,
          [
            shared,
            {
              ...diagnostic,
              text: 'Usage branch B',
              data: { inputTokens: 20 },
            },
            last,
          ],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamIds: [canonical, continuation],
      conflicts: [
        {
          rowId: 'incompatible-diagnostic-row',
          streamIds: [canonical, continuation],
        },
      ],
      conversation: [
        { role: 'user', content: 'First turn' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Shared turn' }],
        },
        { role: 'user', content: 'Last turn' },
      ],
    });
  });

  it('recognizes a connected diagnostic-only archive as an existing execution', async () => {
    const executionId = '0888b30888b3' as ExecutionId;
    const first = 'aOrchestrator@old#0888b30888b3' as StreamTabId;
    const second = 'bOrchestrator@new#0888b30888b3' as StreamTabId;
    await seedStreams(executionId, [{ streamId: first }, { streamId: second }]);

    const sharedDiagnostic = {
      ...logRow(MESSAGE_TYPES.STATISTICS, { text: 'Usage recorded' }),
      id: 'shared-diagnostic-only-row',
    };
    await persistRows(
      executionId,
      new Map([
        [first, [sharedDiagnostic]],
        [second, [sharedDiagnostic]],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'none',
      streamIds: [first, second],
      conversation: null,
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain(`Merged streams: ${first}, ${second}`);
    expect(endpoint.output).toContain('Returned message interval: [0, 0)');
  });

  it('recognizes a sole diagnostic-only root as an existing execution', async () => {
    const executionId = '0888c20888c2' as ExecutionId;
    const streamId = 'orchestrator@model#0888c20888c2' as StreamTabId;
    await seedStreams(executionId, [{ streamId }]);
    await persistRows(
      executionId,
      new Map([
        [
          streamId,
          [logRow(MESSAGE_TYPES.STATISTICS, { text: 'Usage recorded' })],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'none',
      streamId,
      conversation: null,
    });
    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain(`Stream: ${streamId}`);
  });

  it('uses proven child associations as existence evidence without reading them', async () => {
    const executionId = '0888b40888b4' as ExecutionId;
    const parent = 'orchestrator@model#parent' as StreamTabId;
    const firstChild = 'bash@tool#0888b40888b4' as StreamTabId;
    const secondChild = 'codex@tool#0888b40888b4' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: firstChild, agent: 'bash', parent },
      { streamId: secondChild, agent: 'codex', parent },
    ]);
    await persistRows(
      executionId,
      new Map([
        [
          firstChild,
          [logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'First child row' })],
        ],
        [
          secondChild,
          [
            logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
              text: 'Second child row',
            }),
          ],
        ],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'none',
      associatedStreamIds: [firstChild, secondChild],
      conversation: null,
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain(
      `Associated streams: ${firstChild}, ${secondChild}`,
    );
    expect(endpoint.output).toContain('Conversation (0 messages)');
    expect(endpoint.output).not.toContain('First child row');
    expect(endpoint.output).not.toContain('Second child row');
    expect(endpoint.output).not.toContain('Ambiguous candidate streams:');
    expect(endpoint.output).not.toContain('Merged streams:');
  });

  it('contracts a copied diagnostic bridge while preserving conversation order', async () => {
    const executionId = '0888b10888b1' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b10888b1' as StreamTabId;
    const continuation = 'bOrchestrator@new#0888b10888b1' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: continuation },
    ]);

    const first = logRow(MESSAGE_TYPES.USER_MESSAGE, {
      text: 'Before diagnostic bridge',
    });
    const bridge = {
      ...logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Copied status' }),
      id: 'copied-diagnostic-bridge',
    };
    const second = logRow(MESSAGE_TYPES.MODEL_RESPONSE, {
      text: 'After diagnostic bridge',
    });
    await persistRows(
      executionId,
      new Map([
        [canonical, [first, bridge]],
        [continuation, [bridge, second]],
      ]),
    );

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      source: 'streamLog',
      streamIds: [canonical, continuation],
      conversation: [
        { role: 'user', content: 'Before diagnostic bridge' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'After diagnostic bridge' }],
        },
      ],
    });
  });

  it('reports acyclic ambiguity without selecting an unproven archive', async () => {
    const executionId = '0888b70888b7' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888b70888b7' as StreamTabId;
    const ambiguous = 'bOrchestrator@new#0888b70888b7' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: ambiguous },
    ]);

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
      source: 'none',
      candidateStreamIds: [canonical, ambiguous],
      hasOrderingAmbiguity: true,
      conversation: null,
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
        `Ambiguous candidate streams: ${canonical}, ${ambiguous}`,
      );
      expect(page.output).not.toContain('Canonical branch');
      expect(page.output).not.toContain('Ambiguous branch');
      expect(page.output).toContain('Returned message interval: [0, 0)');
    }
  });

  it('reports copied-row cycles without selecting an unproven archive', async () => {
    const executionId = '0888bf0888bf' as ExecutionId;
    const canonical = 'aOrchestrator@old#0888bf0888bf' as StreamTabId;
    const contradictory = 'bOrchestrator@new#0888bf0888bf' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: canonical },
      { streamId: contradictory },
    ]);

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
      source: 'none',
      candidateStreamIds: [canonical, contradictory],
      hasOrderingCycle: true,
      conversation: null,
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.output).toContain('Ordering cycle detected: yes');
    expect(endpoint.output).not.toContain('Merged streams:');
  });

  it('preserves a sole diagnostic-only exact root as execution evidence', async () => {
    const executionId = '0999cb0999cb' as ExecutionId;
    const root = 'orchestrator@model#0999cb0999cb' as StreamTabId;
    await seedStreams(executionId, [{ streamId: root }]);

    const logs = await StreamLogStore.open();
    appendTranscriptEntry(
      logs,
      root,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Root status only' }),
    );
    await logs.flush();

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      conversation: null,
      source: 'none',
      streamId: root,
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain('Conversation (0 messages)');
    expect(endpoint.output).toContain(`Stream: ${root}`);
  });

  it('never substitutes child conversation rows for empty confirmed roots', async () => {
    const executionId = '0999cc0999cc' as ExecutionId;
    const root = 'orchestrator@model#0999cc0999cc' as StreamTabId;
    const child = 'child@tool#0999cc0999cc' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: root },
      { streamId: child, agent: 'bash', parent: root },
    ]);

    const logs = await StreamLogStore.open();
    appendTranscriptEntry(
      logs,
      root,
      logRow(MESSAGE_TYPES.PROGRESS_STATUS, { text: 'Root status only' }),
    );
    appendTranscriptEntry(
      logs,
      child,
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Child-only prompt' }),
    );
    appendTranscriptEntry(
      logs,
      child,
      logRow(MESSAGE_TYPES.MODEL_RESPONSE, { text: 'Child-only answer' }),
    );
    await logs.flush();

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      conversation: null,
      source: 'none',
      streamId: root,
      associatedStreamIds: [child],
    });
  });

  it('retains existence evidence when only several proven child streams remain', async () => {
    const executionId = '0999ce0999ce' as ExecutionId;
    const parent = 'orchestrator@model#parent' as StreamTabId;
    const firstChild = 'bash@tool#0999ce0999ce' as StreamTabId;
    const secondChild = 'codex@tool#0999ce0999ce' as StreamTabId;
    await seedStreams(executionId, [
      { streamId: firstChild, agent: 'bash', parent },
      { streamId: secondChild, agent: 'codex', parent },
    ]);

    await expect(readCompletedRunConversation(executionId)).resolves.toEqual({
      conversation: null,
      source: 'none',
      associatedStreamIds: [firstChild, secondChild],
    });

    const endpoint = await new ExecutionsTool().call({
      path: `/executions/${executionId}/conversation`,
    });
    expect(endpoint.status).toBe('executed');
    expect(endpoint.output).toContain(
      `Associated streams: ${firstChild}, ${secondChild}`,
    );
    expect(endpoint.output).toContain('Returned message interval: [0, 0)');
  });

  it('reads a historical execution whose canonical stream is delegated', async () => {
    const executionId = '0999cd0999cd' as ExecutionId;
    const streamId = 'child@tool#0999cd0999cd' as StreamTabId;
    const parentStreamId = 'orchestrator@model#parent' as StreamTabId;
    await seedStreams(executionId, [
      { streamId, agent: 'bash', parent: parentStreamId },
    ]);

    const logs = await StreamLogStore.open();
    appendTranscriptEntry(
      logs,
      streamId,
      logRow(MESSAGE_TYPES.USER_MESSAGE, { text: 'Delegated question' }),
    );
    appendTranscriptEntry(
      logs,
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
});
