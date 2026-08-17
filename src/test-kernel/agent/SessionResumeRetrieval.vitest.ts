import { describe, expect, it, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import {
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  PersistedFlowStateError,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import {
  runToolUseFlow,
  type RunToolUseFlowResult,
  type RunToolUseFlowInput,
  type ToolUseFlowAttachment,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import {
  parseToolUseShared,
  type StateSlicesSnapshot,
} from '@agent/implementations/flows/tooluse/nodes/types';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

import { testModelCell } from './modelCellTestUtils';
import { reflectionFlowShared } from './progressTestUtils';
import { roundModelHandler } from './toolUseRoundTestUtils';

const CONFIG = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'gpt54',
  instruction: 'Continue.',
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: '/workspace',
});
const GOOGLE_CONFIG: AgentConfig = { ...CONFIG, model: 'gemini35f' };
const WORKFLOW_CONFIG: AgentConfig = {
  ...CONFIG,
  agentCategory: AgentCategory.Workflow,
};

function structuredOutputConfig(): AgentConfig {
  return AgentConfigSchema.parse({
    ...CONFIG,
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
  });
}

const TOOL_USE_SETTING = AgentToolUseSettingSchema.parse({});
const TOOL_USE_PROMPT = AgentPromptSchema.parse({});
const ACTIVE_COMPATIBILITY_KEY = 'ModelHandlerOpenAIResponse';
const WAIT_NODE_CURSOR = 'start/default/default';
const CONTINUATION_GENERATION_ID = '2c25c6a6-6c3f-4d64-9d1f-4a4f2c9b7e10';
const VALID_TOOL_USE_SHARED = {
  messages: [],
  continuationGenerationId: CONTINUATION_GENERATION_ID,
  shouldSkipCycle: false,
  stateSlices: null,
};

// Stored shared state left by a run whose handler identity was persisted.
function activeHandlerShared(): Record<string, unknown> {
  return {
    ...VALID_TOOL_USE_SHARED,
    modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
  };
}

function createAbortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}
type ToolUseSetupContext = Parameters<ToolUseFlowAttachment['attach']>[0];

// A record parked on the wait node, as a resumable turn leaves it.
const WAITING_AT_START = {
  cursor: { nextNodeId: WAIT_NODE_CURSOR },
  nodes: [
    { action: 'default', nodeId: 'start' },
    { action: 'default', nodeId: 'start/default' },
  ],
};

async function writeFlowRecord(
  executionId: ExecutionId,
  shared: unknown,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await getExecutionStore(executionId).write(flowKey(executionId), {
    flowName: 'texra',
    shared,
    createdAt: new Date().toISOString(),
    cursor: { nextNodeId: 'start' },
    nodes: [],
    ...overrides,
  });
}

function readFlowRecord(
  executionId: ExecutionId,
): Promise<FlowRecord | undefined> {
  return getExecutionStore(executionId).read<FlowRecord>(flowKey(executionId));
}

async function retrieveToolUseResume(
  streamId: StreamTabId,
  executionId: ExecutionId,
  config: AgentConfig = CONFIG,
  options?: Parameters<typeof retrieveSessionResumeData>[3],
): Promise<ToolUseResumeData> {
  const resume = await retrieveSessionResumeData(
    streamId,
    executionId,
    config,
    options,
  );
  expect(resume?.type).toBe('toolUse');
  if (resume?.type !== 'toolUse') {
    throw new Error(`Expected tool-use resume data for stream: ${streamId}`);
  }
  return resume;
}

// Most flow-record fixtures below persist a fresh run/workspace snapshot
// with only the current model and (occasionally) a transient override
// varying between cases.
function defaultStateSlices(
  model = 'gpt54',
  transient: Record<string, string> = {},
): StateSlicesSnapshot {
  return {
    runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
    workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
    userChannels: {
      input: Object.freeze({ MODEL: model }),
      transient,
    },
  };
}

function createTaggedModelCell(
  compatibilityKey: ModelHandlerCompatibilityKey,
  modelId: string,
  handler: Record<string, unknown> = {
    extractAssistantText: () => undefined,
  },
): RunToolUseFlowInput['modelCell'] {
  // ModelFactory installs this non-enumerable tag on every active handler.
  Object.defineProperty(handler, '__texraModelHandlerCompatibilityKey', {
    value: compatibilityKey,
  });
  return testModelCell(handler, modelId);
}

function testToolCall(name: string, input: unknown): SdkToolCall {
  return {
    provider: 'deepseek',
    callId: `call-${name}`,
    name,
    input,
    raw: {} as never,
  };
}

interface TestModelTurn {
  readonly text?: string;
  readonly error?: Error;
  readonly toolCalls?: SdkToolCall[];
  readonly updatedMessages?: Array<Record<string, unknown>>;
}

function responseModelHandler(
  turns: readonly TestModelTurn[],
  overrides: Record<string, unknown> = {},
) {
  const pendingTurns = [...turns];
  return roundModelHandler({
    requiresPerCallSystemPrompt: false,
    initializeMessages: async () => [{ role: 'user', content: 'Start.' }],
    consumeInsertedAttachmentKinds: () => [],
    createUserFollowUpMessages: async (
      messages: Array<Record<string, unknown>>,
      text: string,
    ) => [...messages, { role: 'user', content: text }],
    createResponse: vi.fn(async () => {
      const turn = pendingTurns.shift();
      if (!turn) throw new Error('Unexpected model invocation');
      if (turn.error) throw turn.error;
      return {
        response: { text: turn.text ?? '', toolCalls: turn.toolCalls ?? [] },
        updatedMessages: turn.updatedMessages,
      };
    }),
    extractResponse: (response: unknown) => {
      const { text, toolCalls } = response as {
        text: string;
        toolCalls: SdkToolCall[];
      };
      return {
        text,
        usage: null,
        stopReason: toolCalls.length ? 'tool_use' : 'stop',
      };
    },
    extractToolUse: (response: unknown) =>
      (response as { toolCalls: SdkToolCall[] }).toolCalls,
    createToolUseFollowUpMessages: async (
      _client: unknown,
      call: SdkToolCall,
      result: unknown,
      _attachments: unknown,
      _workspace: AgentWorkspaceState,
      assistantText?: string,
    ) => [
      ...(assistantText ? [{ role: 'assistant', content: assistantText }] : []),
      {
        role: 'tool',
        tool_call_id: call.callId,
        content: JSON.stringify(result),
      },
    ],
    ...overrides,
  });
}

function buildToolUseResumeData(
  executionId: ExecutionId,
  streamId: StreamTabId,
): ToolUseResumeData {
  const shared = {
    messages: [],
    continuationGenerationId: CONTINUATION_GENERATION_ID,
    shouldSkipCycle: false,
    stateSlices: defaultStateSlices(),
  };
  return {
    type: 'toolUse',
    executionId,
    streamId,
    agentConfig: CONFIG,
    shared,
  };
}

function buildResponseResumeData(
  executionId: ExecutionId,
  streamId: StreamTabId,
  response: string,
): ToolUseResumeData {
  const shared = {
    messages: [{ role: 'assistant', content: response }],
    lastResponse: response,
    continuationGenerationId: CONTINUATION_GENERATION_ID,
    shouldSkipCycle: false,
    stateSlices: defaultStateSlices(),
  };
  return {
    type: 'toolUse',
    executionId,
    streamId,
    agentConfig: CONFIG,
    shared,
  };
}

interface PersistedFlowRunOptions {
  readonly attachment?: Partial<ToolUseFlowAttachment>;
  readonly session?: SessionHandle;
  readonly isSubagent?: boolean;
  readonly stopAfterCycle?: boolean;
  readonly config?: AgentConfig;
  readonly modelHandler?: Record<string, unknown>;
  readonly tools?: readonly ITool[];
  readonly drainedFollowUps?: RunToolUseFlowInput['drainedFollowUps'];
  readonly onIdle?: () => void;
  readonly takePendingFollowUps?: RunToolUseFlowInput['takePendingFollowUps'];
  readonly onFlowRecordDisposition?: (
    disposition: 'preserve' | 'delete',
  ) => void;
}

async function runPersistedFlow(
  executionId: ExecutionId,
  streamId: StreamTabId,
  resume: ToolUseResumeData | undefined,
  options: PersistedFlowRunOptions = {},
): Promise<RunToolUseFlowResult> {
  const { attachment } = options;
  const session = options.session ?? createTestSession();
  const config = options.config ?? resume?.agentConfig ?? CONFIG;
  const userVarChannels = resume?.shared.stateSlices.userChannels ?? {
    input: Object.freeze({ MODEL: config.model }),
    transient: {},
  };
  const abortController = new AbortController();
  const runScope = createRunScope({
    streamId,
    executionId,
    agentName: config.agent,
    session,
    signal: abortController.signal,
  });
  const modelCell = createTaggedModelCell(
    ACTIVE_COMPATIBILITY_KEY,
    config.model,
    options.modelHandler,
  );
  const context = createRunContext({
    runScope,
    modelCell,
    stopAfterCycle: options.stopAfterCycle,
  });
  const hostAttachment = attachment && {
    attach: (flowContext: ToolUseSetupContext): void =>
      attachment.attach?.(flowContext),
    detach: (flowContext: ToolUseSetupContext): void =>
      attachment.detach?.(flowContext),
  };

  try {
    return await withRunContext(context, () =>
      runToolUseFlow(
        {
          config,
          runScope,
          setting: TOOL_USE_SETTING,
          prompt: TOOL_USE_PROMPT,
          logger: noopTrace,
          userVarChannels,
          modelCell,
          toolPolicy: createToolPolicy({
            stopAfterCycle: options.stopAfterCycle,
          }),
          onModelChanged: () => {},
          interrupt: () => abortController.abort(),
          onRoundFinalized: () => {},
          ...(resume !== undefined && { resume }),
          drainedFollowUps: options.drainedFollowUps,
          isSubagent: options.isSubagent ?? true,
          tools: options.tools,
          onIdle: options.onIdle,
          takePendingFollowUps: options.takePendingFollowUps,
          onFlowRecordDisposition: options.onFlowRecordDisposition,
          toolInjections: new ToolInjectionRegistry(),
        },
        new MapToolRegistry({}),
        hostAttachment,
      ),
    );
  } finally {
    session.dispose();
  }
}

async function runResumedFlowToWaiting(
  executionId: ExecutionId,
  streamId: StreamTabId,
  resume: ToolUseResumeData,
): Promise<void> {
  const result = await runPersistedFlow(executionId, streamId, resume);
  expect(result.outcome).toBe(STREAM_PHASE.WAITING);
}

describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('rejects malformed fields at the shared-state boundary', () => {
    expect(
      parseToolUseShared({
        messages: [],
        shouldSkipCycle: 'false',
        stateSlices: null,
      }),
    ).toEqual({
      success: false,
      error: expect.objectContaining({ name: 'ZodError' }),
    });
  });

  it('rejects a malformed MODEL user variable at the shared-state boundary', () => {
    const result = parseToolUseShared({
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices('gpt54', {
        MODEL: 42,
      } as unknown as Record<string, string>),
    });

    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({ name: 'ZodError' }),
    });
  });

  it('retrieves a workflow record with the current conversation field', async () => {
    const executionId = 'workflow-current-conversation' as ExecutionId;
    const streamId =
      'reflection@gpt54#workflow-current-conversation' as StreamTabId;
    await writeFlowRecord(
      executionId,
      reflectionFlowShared({
        currentRound: 1,
        conversation: [{ role: 'user', content: 'Continue.' }],
      }),
    );

    await expect(
      retrieveSessionResumeData(streamId, executionId, WORKFLOW_CONFIG),
    ).resolves.toMatchObject({ type: 'workflow', executionId });
  });

  it('rejects a workflow record that only has the retired messages field', async () => {
    const executionId = 'workflow-retired-messages' as ExecutionId;
    const streamId =
      'reflection@gpt54#workflow-retired-messages' as StreamTabId;
    await writeFlowRecord(executionId, {
      currentRound: 1,
      totalRounds: 2,
      messages: [{ role: 'user', content: 'Continue.' }],
    });

    await expect(
      retrieveSessionResumeData(streamId, executionId, WORKFLOW_CONFIG),
    ).resolves.toBeNull();
  });

  it('preserves structured output at the persisted shared-state boundary', () => {
    const continuationGenerationId = '6f2051ec-5169-4fb5-9830-47aba9df665a';
    const result = parseToolUseShared({
      messages: [],
      continuationGenerationId,
      shouldSkipCycle: false,
      stateSlices: null,
      structured: { title: 'Durable result' },
    });

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        continuationGenerationId,
        structured: { title: 'Durable result' },
      }),
      changed: false,
    });
  });

  it('does not derive a missing model id from the MODEL user variable', () => {
    const result = parseToolUseShared({
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices('gpt54', { MODEL: 'gpt55' }),
    });

    expect(result).toMatchObject({ success: true, changed: false });
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('modelId');
  });

  it('keeps a persisted model id over the MODEL variable', () => {
    const continuationGenerationId = '8439c273-d7f7-442a-9930-e63e941263d8';
    const result = parseToolUseShared({
      messages: [],
      continuationGenerationId,
      modelId: 'gpt55',
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices('gpt54', { MODEL: 'gpt54' }),
    });

    expect(result).toMatchObject({
      success: true,
      data: { continuationGenerationId, modelId: 'gpt55' },
      changed: false,
    });
  });

  it('rejects a record without a continuation generation', () => {
    // The pre-fencing omission reader is retired: intermediate-era records
    // that never persisted a generation id fail the parse loudly instead of
    // being backfilled with a fresh UUID.
    const result = parseToolUseShared({
      messages: [],
      shouldSkipCycle: false,
      stateSlices: null,
    });

    expect(result.success).toBe(false);
  });

  it('uses the persisted model id while preserving the original stream id', async () => {
    const executionId = 'abc123' as ExecutionId;
    const streamId = 'chat@gpt54#abc123' as StreamTabId;
    await writeFlowRecord(executionId, {
      messages: [],
      modelId: 'gpt55',
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      // A stale MODEL projection must not win over the persisted model id.
      stateSlices: defaultStateSlices('gpt54', { MODEL: 'gpt54' }),
    });

    const resume = await retrieveToolUseResume(streamId, executionId);

    expect(resume.streamId).toBe(streamId);
    expect(resume.shared.modelId).toBe('gpt55');
    expect(resume.agentConfig.model).toBe('gpt55');
  });

  it('uses the launch model when only MODEL contains a retired identity', async () => {
    const executionId = 'abc123-legacy-model' as ExecutionId;
    const streamId = 'chat@gpt54#abc123-legacy-model' as StreamTabId;
    await writeFlowRecord(executionId, {
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices('gpt54', { MODEL: 'gpt55' }),
    });

    const resume = await retrieveToolUseResume(streamId, executionId);

    expect(resume.shared.modelId).toBeUndefined();
    expect(resume.agentConfig.model).toBe(CONFIG.model);
  });

  it('falls back to the launch model when nothing persisted a model', async () => {
    const executionId = 'abc123-no-model' as ExecutionId;
    const streamId = 'chat@gpt54#abc123-no-model' as StreamTabId;
    await writeFlowRecord(executionId, {
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: {
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
        workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
        userChannels: { input: Object.freeze({}), transient: {} },
      },
    });

    const resume = await retrieveToolUseResume(streamId, executionId);

    expect(resume.shared.modelId).toBeUndefined();
    expect(resume.agentConfig.model).toBe(CONFIG.model);
  });

  it('preserves a recovered parent stream id in tool-use snapshots', async () => {
    const executionId = 'abc131' as ExecutionId;
    const streamId = 'chat@gpt54#abc131-child' as StreamTabId;
    const parentStreamId = 'chat@gpt54#abc131-parent' as StreamTabId;
    await writeFlowRecord(executionId, {
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices(),
    });

    const resume = await retrieveToolUseResume(streamId, executionId, CONFIG, {
      parentStreamId,
    });

    expect(resume.parentStreamId).toBe(parentStreamId);
  });

  it('rejects a Google record without persisted handler identity', async () => {
    const executionId = 'abc124' as ExecutionId;
    const streamId = 'chat@gemini35f#abc124' as StreamTabId;
    const shared = {
      messages: [
        {
          type: 'user_input',
          content: [{ type: 'text', text: 'Continue.' }],
        },
      ],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices('gemini35f'),
    };
    await writeFlowRecord(executionId, shared);

    await expect(
      retrieveSessionResumeData(streamId, executionId, GOOGLE_CONFIG),
    ).rejects.toThrow(
      `Failed to retrieve tool-use resume data for stream: ${streamId}`,
    );
    expect((await readFlowRecord(executionId))?.shared).toEqual(shared);
  });

  it('throws when resumable tool-use storage cannot be read', async () => {
    const executionId = 'abc129' as ExecutionId;
    const streamId = 'chat@gpt54#abc129' as StreamTabId;
    const store = getExecutionStore(executionId);
    await writeFlowRecord(executionId, {
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices(),
    });
    const originalRead = store.read.bind(store);
    const readSpy = vi.spyOn(store, 'read').mockImplementation(async (key) => {
      if (key === flowKey(executionId)) {
        throw new Error('KV timeout');
      }
      return originalRead(key);
    });

    try {
      await expect(
        retrieveSessionResumeData(streamId, executionId, CONFIG),
      ).rejects.toThrow(
        `Failed to retrieve tool-use resume data for stream: ${streamId}`,
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it('throws when tool-use metadata is invalid even if the flow record is valid', async () => {
    const executionId = 'abc130' as ExecutionId;
    const streamId = 'chat@gpt54#abc130' as StreamTabId;
    const store = getExecutionStore(executionId);
    await store.write('meta', {
      schemaVersion: 999,
      timestamp: '2026-07-05T00:00:00.000Z',
    });
    await writeFlowRecord(executionId, {
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices(),
    });

    await expect(
      retrieveSessionResumeData(streamId, executionId, CONFIG),
    ).rejects.toThrow(
      `Failed to retrieve tool-use resume data for stream: ${streamId}`,
    );
  });
});

describe('runToolUseFlow consumes the resume boundary instead of re-parsing', () => {
  setupPlatform({ workspacePath: '/workspace' });

  it('creates fresh shared state when the flow record is absent', async () => {
    const executionId = 'abc-flow-absent' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-absent' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);

    const result = await runPersistedFlow(executionId, streamId, snapshot);

    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
    const stored = await readFlowRecord(executionId);
    expect(stored?.shared).toMatchObject({
      messages: snapshot.shared.messages,
      stateSlices: snapshot.shared.stateSlices,
    });
  });

  it.each([
    { name: 'persisted record', persistRecord: true },
    { name: 'absent record with resume handoff', persistRecord: false },
  ])(
    'does not return a prior assistant response when a resumed child produces no new answer: $name',
    async ({ persistRecord }) => {
      const suffix = persistRecord ? 'record' : 'handoff';
      const executionId = `abc-flow-stale-response-${suffix}` as ExecutionId;
      const streamId =
        `chat@gpt54#abc-flow-stale-response-${suffix}` as StreamTabId;
      const resume = buildResponseResumeData(executionId, streamId, 'A');
      if (persistRecord) {
        await writeFlowRecord(executionId, resume.shared, WAITING_AT_START);
      }

      const result = await runPersistedFlow(executionId, streamId, resume);

      expect(result).toMatchObject({ outcome: STREAM_PHASE.WAITING });
      expect(result.response).toBeUndefined();
    },
  );

  it.each([
    { name: 'different text', prior: 'A', fresh: 'B' },
    { name: 'identical text', prior: 'A', fresh: 'A' },
  ])(
    'returns a response produced by a real resumed model cycle: $name',
    async ({ prior, fresh }) => {
      const suffix = prior === fresh ? 'identical' : 'different';
      const executionId =
        `abc-flow-fresh-resumed-response-${suffix}` as ExecutionId;
      const streamId =
        `chat@gpt54#abc-flow-fresh-resumed-response-${suffix}` as StreamTabId;
      const resume = buildResponseResumeData(executionId, streamId, prior);
      await writeFlowRecord(executionId, resume.shared, WAITING_AT_START);

      const result = await runPersistedFlow(executionId, streamId, resume, {
        modelHandler: responseModelHandler([{ text: fresh }]),
        drainedFollowUps: [{ text: 'Continue.', origin: 'user' }],
      });

      expect(result.response).toBe(fresh);
    },
  );

  it('retains identical partial text produced before a resumed cycle fails', async () => {
    const executionId = 'abc-flow-identical-partial-response' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-identical-partial-response' as StreamTabId;
    const resume = buildResponseResumeData(executionId, streamId, 'A');
    await writeFlowRecord(executionId, resume.shared, WAITING_AT_START);

    const result = await runPersistedFlow(executionId, streamId, resume, {
      modelHandler: responseModelHandler([{ text: 'A' }], {
        createAssistantMessageFromResponse: () => {
          throw new Error('Provider stream failed after partial output');
        },
      }),
      drainedFollowUps: [{ text: 'Continue.', origin: 'user' }],
    });

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.FAILED,
      response: 'A',
      error: {
        message: expect.stringContaining(
          'Provider stream failed after partial output',
        ),
      },
    });
  });

  it('scrubs persisted assembly text before an answerless resumed cycle fails', async () => {
    const executionId = 'abc-flow-stale-assembly-response' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-stale-assembly-response' as StreamTabId;
    const baseResume = buildResponseResumeData(executionId, streamId, 'A');
    const shared = {
      ...baseResume.shared,
      stateSlices: {
        ...baseResume.shared.stateSlices,
        workspaceSnapshot: {
          ...baseResume.shared.stateSlices.workspaceSnapshot,
          assembly: { lastResponse: 'A', accumulatedOutput: 'A' },
        },
      },
    };
    const resume: ToolUseResumeData = {
      ...baseResume,
      shared,
    };
    await writeFlowRecord(executionId, resume.shared, WAITING_AT_START);
    const providerError = Object.assign(
      new Error('Answerless provider failure'),
      {
        status: 401,
      },
    );

    const result = await runPersistedFlow(executionId, streamId, resume, {
      modelHandler: responseModelHandler([{ error: providerError }]),
      drainedFollowUps: [{ text: 'Continue.', origin: 'user' }],
    });

    expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
    expect(result.response).toBeUndefined();
  });

  it('returns explanatory text accompanying submit_output', async () => {
    const executionId = 'abc-flow-terminal-tool-response' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-terminal-tool-response' as StreamTabId;
    const config = structuredOutputConfig();

    const result = await runPersistedFlow(executionId, streamId, undefined, {
      config,
      isSubagent: false,
      stopAfterCycle: true,
      modelHandler: responseModelHandler([
        {
          text: 'Here is the structured result.',
          toolCalls: [testToolCall('submit_output', { answer: 'done' })],
        },
      ]),
    });

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.COMPLETED,
      response: 'Here is the structured result.',
      structured: { answer: 'done' },
    });
  });

  it('retains tool-round text when a later model round fails', async () => {
    const executionId = 'abc-flow-tool-text-later-failure' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-tool-text-later-failure' as StreamTabId;
    const providerError = Object.assign(new Error('Later provider failure'), {
      status: 401,
    });
    const probeTool: ITool = {
      definition: {
        name: 'probe',
        description: 'Probe once',
        parameters: {},
      },
      call: vi.fn(async () => ({ status: 'executed' as const, output: 'ok' })),
    };

    const result = await runPersistedFlow(executionId, streamId, undefined, {
      modelHandler: responseModelHandler([
        {
          text: 'I checked the tool.',
          toolCalls: [testToolCall('probe', {})],
        },
        { error: providerError },
      ]),
      tools: [probeTool],
    });

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.FAILED,
      response: 'I checked the tool.',
      error: { message: expect.stringContaining('Later provider failure') },
    });
  });

  it('retains a fresh response when compaction replaces the whole message array', async () => {
    const executionId = 'abc-flow-compacted-response' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-compacted-response' as StreamTabId;
    const resume = buildResponseResumeData(executionId, streamId, 'A');
    await writeFlowRecord(executionId, resume.shared, WAITING_AT_START);

    const result = await runPersistedFlow(executionId, streamId, resume, {
      modelHandler: responseModelHandler([
        {
          text: 'B',
          updatedMessages: [{ role: 'user', content: 'Compacted context.' }],
        },
      ]),
      drainedFollowUps: [{ text: 'Continue.', origin: 'user' }],
    });

    expect(result.response).toBe('B');
    expect(await readFlowRecord(executionId)).toMatchObject({
      shared: {
        messages: [
          { role: 'user', content: 'Compacted context.' },
          { role: 'assistant', content: 'B' },
        ],
      },
    });
  });

  it('keeps returning a response from a fresh root model cycle', async () => {
    const executionId = 'abc-flow-fresh-root-response' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-fresh-root-response' as StreamTabId;

    const result = await runPersistedFlow(executionId, streamId, undefined, {
      isSubagent: false,
      stopAfterCycle: true,
      modelHandler: responseModelHandler([{ text: 'fresh answer' }]),
    });

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.COMPLETED,
      response: 'fresh answer',
    });
  });

  it('returns the latest response across real same-invocation follow-up cycles', async () => {
    const executionId = 'abc-flow-multiple-cycle-response' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-multiple-cycle-response' as StreamTabId;
    const takePendingFollowUps = vi
      .fn<NonNullable<RunToolUseFlowInput['takePendingFollowUps']>>()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ text: 'Continue.', origin: 'user' }])
      .mockReturnValue([]);

    const result = await runPersistedFlow(executionId, streamId, undefined, {
      modelHandler: responseModelHandler([
        { text: 'first answer' },
        { text: 'latest answer' },
      ]),
      takePendingFollowUps,
    });

    expect(result).toMatchObject({
      outcome: STREAM_PHASE.WAITING,
      response: 'latest answer',
    });
    expect(takePendingFollowUps).toHaveBeenCalledTimes(3);
  });

  it('offers queue ownership again after a resumed subagent parks', async () => {
    const executionId = 'abc-flow-post-park-owner' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-post-park-owner' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const boundaryEvents: string[] = [];
    const takePendingFollowUps = vi.fn(() => {
      boundaryEvents.push('take');
      return [];
    });

    const result = await runPersistedFlow(executionId, streamId, snapshot, {
      attachment: {
        attach: () => {
          boundaryEvents.push('attach');
        },
        detach: () => {
          boundaryEvents.push('detach');
        },
      },
      takePendingFollowUps,
    });

    expect(result.outcome).toBe(STREAM_PHASE.WAITING);
    expect(takePendingFollowUps).toHaveBeenCalledTimes(2);
    expect(boundaryEvents).toEqual(['attach', 'take', 'detach', 'take']);
  });

  it('detaches a host whose attach threw after wiring itself up', async () => {
    // `executeAgent`'s attach registers the flow context on the run handle and
    // may then interrupt it. A throw anywhere after that first statement used
    // to strand the live context on the handle, because the pairing lived in
    // the value the callback never got to return.
    const executionId = 'abc-flow-attach-failure' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-attach-failure' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const attachFailure = new Error('host wiring failed');
    const detached: ToolUseSetupContext[] = [];

    await expect(
      runPersistedFlow(executionId, streamId, snapshot, {
        attachment: {
          attach: () => {
            throw attachFailure;
          },
          detach: (context) => {
            detached.push(context);
          },
        },
      }),
    ).rejects.toBe(attachFailure);
    expect(detached).toHaveLength(1);
  });

  it.each([
    { name: 'resumed run', resume: true },
    { name: 'fresh launch', resume: false },
  ])(
    'releases follow-ups while preserving the record after a persistence read failure: $name',
    async ({ resume }) => {
      const suffix = resume ? 'resume' : 'fresh';
      const executionId = `abc-flow-read-failure-${suffix}` as ExecutionId;
      const streamId =
        `chat@gpt54#abc-flow-read-failure-${suffix}` as StreamTabId;
      const snapshot = resume
        ? buildToolUseResumeData(executionId, streamId)
        : undefined;
      const store = getExecutionStore(executionId);
      const session = createTestSession();
      const readFailure = new Error('flow storage unavailable');
      const readSpy = vi
        .spyOn(store, 'read')
        .mockRejectedValueOnce(readFailure);
      const deleteSpy = vi.spyOn(store, 'delete');

      try {
        await expect(
          runPersistedFlow(executionId, streamId, snapshot, {
            attachment: {
              attach: (context) => {
                context.session.appendFollowUp({
                  text: 'queued before recovery',
                });
              },
            },
            session,
          }),
        ).rejects.toMatchObject({
          name: PersistedFlowStateError.name,
          reason: 'read-failed',
          cause: readFailure,
        });
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(session.followUps.getAll(streamId)).toEqual([]);
      } finally {
        readSpy.mockRestore();
        deleteSpy.mockRestore();
        session.followUps.terminalize(streamId);
      }
    },
  );

  it('preserves the structured flow error when teardown also fails', async () => {
    const executionId = 'abc-flow-primary-and-teardown-failure' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-primary-and-teardown-failure' as StreamTabId;
    const base = buildToolUseResumeData(executionId, streamId);
    const failedShared = {
      ...base.shared,
      lastError: {
        message: 'provider failed after partial output',
        userRetryable: true,
      },
      lastResponse: 'partial assistant response',
    };
    const snapshot: ToolUseResumeData = {
      ...base,
      shared: failedShared,
    };
    // A terminal cursor makes the resumed flow exit COMPLETE without stepping
    // any node, leaving the failed shared state exactly as persisted.
    await writeFlowRecord(executionId, failedShared, {
      cursor: { nextNodeId: null, lastAction: FlowTransition.COMPLETE },
    });
    const session = createTestSession();
    const teardownFailure = new Error('flow detachment failed');
    const releaseSpy = vi.spyOn(session.followUps, 'release');
    const errorLogSpy = vi
      .spyOn(noopTrace, 'error')
      .mockImplementation(() => {});

    try {
      // The run's own failure outranks the teardown failure: it is carried
      // out on the result rather than replaced by the thrown teardown error.
      const result = await runPersistedFlow(executionId, streamId, snapshot, {
        attachment: {
          detach: () => {
            throw teardownFailure;
          },
        },
        session,
      });

      expect(result).toMatchObject({
        outcome: RUN_OUTCOME.FAILED,
        error: failedShared.lastError,
      });
      expect(releaseSpy).toHaveBeenCalled();
      expect(errorLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('detaching the live flow'),
        expect.any(Object),
      );
    } finally {
      releaseSpy.mockRestore();
      errorLogSpy.mockRestore();
    }
  });

  it('surfaces the first teardown failure after an otherwise successful exit', async () => {
    const executionId = 'abc-flow-teardown-failure' as ExecutionId;
    const streamId = 'chat@gpt54#abc-flow-teardown-failure' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const session = createTestSession();
    const teardownFailure = new Error('flow detachment failed');
    const releaseSpy = vi.spyOn(session.followUps, 'release');

    try {
      await expect(
        runPersistedFlow(executionId, streamId, snapshot, {
          attachment: {
            attach: (context) => context.interrupt(),
            detach: () => {
              throw teardownFailure;
            },
          },
          session,
        }),
      ).rejects.toBe(teardownFailure);
      expect(releaseSpy).toHaveBeenCalled();
    } finally {
      releaseSpy.mockRestore();
    }
  });

  it('preserves a missing structured-output failure when teardown also fails', async () => {
    const executionId =
      'abc-flow-structured-output-and-teardown-failure' as ExecutionId;
    const streamId =
      'chat@gpt54#abc-flow-structured-output-and-teardown-failure' as StreamTabId;
    const snapshot = {
      ...buildToolUseResumeData(executionId, streamId),
      agentConfig: structuredOutputConfig(),
    };
    // A terminal cursor makes the resumed flow exit COMPLETE without stepping
    // any node, so the run completes without a structured result.
    await writeFlowRecord(executionId, snapshot.shared, {
      cursor: { nextNodeId: null, lastAction: FlowTransition.COMPLETE },
    });
    const session = createTestSession();
    const teardownFailure = new Error('flow detachment failed');

    await expect(
      runPersistedFlow(executionId, streamId, snapshot, {
        attachment: {
          detach: () => {
            throw teardownFailure;
          },
        },
        session,
      }),
    ).rejects.toThrow(
      'Structured-output run completed without calling submit_output.',
    );
  });

  it.each([
    {
      name: 'legacy record without a replay cursor',
      reason: 'unsupported-record',
      stored: {
        flowName: 'texra',
        shared: VALID_TOOL_USE_SHARED,
        createdAt: '2026-01-01T00:00:00.000Z',
        nodes: [],
      },
    },
    {
      name: 'missing shared state',
      reason: 'missing-shared',
      stored: {
        flowName: 'texra',
        createdAt: '2026-01-01T00:00:00.000Z',
        nodes: [],
      },
    },
    {
      name: 'unsupported null record',
      reason: 'unsupported-record',
      stored: null,
    },
    {
      name: 'valid shared state without nodes',
      reason: 'unsupported-record',
      stored: {
        flowName: 'texra',
        shared: VALID_TOOL_USE_SHARED,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    {
      name: 'future envelope schema version',
      reason: 'unsupported-record',
      stored: {
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION + 1,
        flowName: 'texra',
        shared: VALID_TOOL_USE_SHARED,
        createdAt: '2026-01-01T00:00:00.000Z',
        // Cursor present so the version bound is the only failing constraint.
        cursor: { nextNodeId: 'start' },
        nodes: [],
      },
    },
  ])('rejects and preserves $name', async ({ name, reason, stored }) => {
    const slug = name.replaceAll(' ', '-');
    const executionId = `abc-flow-${slug}` as ExecutionId;
    const streamId = `chat@gpt54#abc-flow-${slug}` as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    await store.write(flowKey(executionId), stored);
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      const expectedError = {
        name: PersistedFlowStateError.name,
        reason,
        cause: expect.objectContaining({ name: 'ZodError' }),
      };
      await expect(
        runPersistedFlow(executionId, streamId, snapshot),
      ).rejects.toMatchObject(expectedError);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await store.read(flowKey(executionId))).toEqual(stored);
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('skips persistence recovery when setup hands off a cancellation', async () => {
    const executionId = 'abc-cancel-setup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-setup' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    const readSpy = vi.spyOn(store, 'read');
    const writeSpy = vi.spyOn(store, 'write');
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      const result = await runPersistedFlow(executionId, streamId, snapshot, {
        attachment: {
          attach: (flowContext) => flowContext.interrupt(),
        },
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(readSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('cleans up a fresh launch cancelled before persistence recovery', async () => {
    const executionId = 'abc-fresh-cancel-setup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-fresh-cancel-setup' as StreamTabId;
    const store = getExecutionStore(executionId);
    const session = createTestSession();
    const readSpy = vi.spyOn(store, 'read');
    const deleteSpy = vi.spyOn(store, 'delete');
    const releaseSpy = vi.spyOn(session.followUps, 'release');
    const dispositions: Array<'preserve' | 'delete'> = [];

    try {
      const result = await runPersistedFlow(executionId, streamId, undefined, {
        attachment: { attach: (flowContext) => flowContext.interrupt() },
        session,
        onFlowRecordDisposition: (value) => dispositions.push(value),
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(readSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalledWith(flowKey(executionId));
      expect(dispositions).toEqual(['delete']);
      expect(releaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ streamId, kind: 'flow' }),
        'terminal',
      );
    } finally {
      readSpy.mockRestore();
      deleteSpy.mockRestore();
      releaseSpy.mockRestore();
    }
  });

  it('skips repair writes when cancellation arrives during the recovery read', async () => {
    const executionId = 'abc-cancel-read' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-read' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;
    const readSpy = vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      flowContext?.interrupt();
      return {
        flowName: 'texra',
        shared: {
          messages: [],
          shouldSkipCycle: true,
          stateSlices: snapshot.shared.stateSlices,
        },
        createdAt: new Date().toISOString(),
        cursor: { nextNodeId: 'start' },
        nodes: [],
      };
    });
    const writeSpy = vi.spyOn(store, 'write');
    const deleteSpy = vi.spyOn(store, 'delete');

    try {
      const result = await runPersistedFlow(executionId, streamId, snapshot, {
        attachment: {
          attach: (context) => {
            flowContext = context;
          },
        },
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(readSpy).toHaveBeenCalledWith(flowKey(executionId));
      expect(writeSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('preserves the resumable flow after an established run is interrupted', async () => {
    const executionId = 'abc-interrupted-conversation' as ExecutionId;
    const streamId = 'chat@gpt54#abc-interrupted-conversation' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;

    const result = await runPersistedFlow(executionId, streamId, snapshot, {
      attachment: {
        attach: (context) => {
          flowContext = context;
        },
      },
      session: createTestSession(),
      isSubagent: false,
      onIdle: () => flowContext?.interrupt(),
    });

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    expect(await readFlowRecord(executionId)).toMatchObject({
      cursor: { nextNodeId: 'start' },
      shared: { shouldSkipCycle: true },
    });
  });

  it('resets the resumable cursor after the user declines a retry', async () => {
    const executionId = 'abc-declined-retry' as ExecutionId;
    const streamId = 'chat@gpt54#abc-declined-retry' as StreamTabId;
    const shared = {
      messages: [],
      continuationGenerationId: CONTINUATION_GENERATION_ID,
      shouldSkipCycle: false,
      stateSlices: defaultStateSlices(),
      userCancelledRetry: true,
    };
    await writeFlowRecord(executionId, shared, {
      cursor: { nextNodeId: null, lastAction: FlowTransition.COMPLETE },
    });

    // The terminal cursor makes the flow exit COMPLETE without stepping any
    // node, leaving the declined-retry marker for the outcome derivation.
    const result = await runPersistedFlow(executionId, streamId, undefined);

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
    expect(await readFlowRecord(executionId)).toMatchObject({
      cursor: { nextNodeId: 'start' },
      shared: { shouldSkipCycle: true, userCancelledRetry: true },
    });
  });

  it('preserves an established flow when provider cancellation rejects the run', async () => {
    const executionId = 'abc-interrupted-provider' as ExecutionId;
    const streamId = 'chat@gpt54#abc-interrupted-provider' as StreamTabId;
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;
    const storedShared = activeHandlerShared();
    const snapshot = buildToolUseResumeData(executionId, streamId);
    await writeFlowRecord(executionId, storedShared);
    const abortError = createAbortError();
    // Reject the flow's first node-step persist with the provider's abort:
    // the run then fails mid-flight through the public storage boundary, the
    // same way a real cancellation reaches `runToolUseFlow` out of the flow.
    // Only step writes append to the nodes audit log, so the resume
    // boundary's self-heal write (nodes stays empty) passes through untouched.
    const realWrite = store.write.bind(store);
    let abortFired = false;
    const writeSpy = vi
      .spyOn(store, 'write')
      .mockImplementation(async (key, value) => {
        if (
          !abortFired &&
          value !== null &&
          typeof value === 'object' &&
          'nodes' in value &&
          Array.isArray(value.nodes) &&
          value.nodes.length > 0
        ) {
          abortFired = true;
          flowContext?.interrupt();
          throw abortError;
        }
        return realWrite(key, value);
      });
    const deleteSpy = vi.spyOn(store, 'delete');
    const dispositions: Array<'preserve' | 'delete'> = [];

    try {
      await expect(
        runPersistedFlow(executionId, streamId, snapshot, {
          attachment: {
            attach: (context) => {
              flowContext = context;
            },
          },
          modelHandler: responseModelHandler([]),
          onFlowRecordDisposition: (value) => dispositions.push(value),
        }),
      ).rejects.toBe(abortError);
      expect(deleteSpy).not.toHaveBeenCalledWith(flowKey(executionId));
      expect(dispositions).toEqual(['preserve']);
      expect(await readFlowRecord(executionId)).toMatchObject({
        cursor: { nextNodeId: 'start' },
        shared: { shouldSkipCycle: true },
      });
    } finally {
      writeSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('preserves a follow-up appended during setup when cancellation arrives during the recovery read (issue #8049 P2)', async () => {
    // Once setup attaches the live flow context, a new follow-up can enter its
    // session queue before the flow is interruptible. When an external
    // cancellation then lands while the recovery read is pending -- the same
    // window as the sibling test above -- the run reports CANCELLED with the
    // resume record preserved, and the queued input must survive with it:
    // `resumeQueuedToolUseFromResumeData` never restores follow-ups on this
    // success path, so dropping the item here would lose it for good.
    const executionId = 'abc-cancel-followup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-followup' as StreamTabId;
    const snapshot = buildToolUseResumeData(executionId, streamId);
    const store = getExecutionStore(executionId);
    const session = createTestSession();
    let flowContext: ToolUseSetupContext | undefined;
    const readSpy = vi.spyOn(store, 'read').mockImplementationOnce(async () => {
      // Cancellation arrives while the recovery read is pending -- after
      // setup already appended the live follow-up below.
      flowContext?.interrupt();
      return undefined;
    });

    try {
      const result = await runPersistedFlow(executionId, streamId, snapshot, {
        attachment: {
          attach: (context) => {
            flowContext = context;
            context.session.appendFollowUp({ text: 'queued during resume' });
          },
        },
        session,
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(session.followUps.getAll(streamId)).toEqual([
        'queued during resume',
      ]);
    } finally {
      readSpy.mockRestore();
      session.followUps.terminalize(streamId);
    }
  });

  it('preserves late input when an orphaned host-resumed subagent is cancelled mid-turn', async () => {
    const executionId = 'abc-cancel-active-followup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-active-followup' as StreamTabId;
    const session = createTestSession();
    const storedShared = activeHandlerShared();
    const snapshot = buildToolUseResumeData(executionId, streamId);
    await writeFlowRecord(executionId, storedShared);
    // `resumeQueuedToolUseFromResumeData` holds the recovery lease across the
    // whole host resume, so the flow borrows that consumer's queue instead of
    // claiming one. Model that here: the borrower may cancel its own wait but
    // never drops the owner's queued input, whatever the run's own outcome.
    const recovery = session.followUps.claimRecovery(streamId, true);
    expect(recovery).toBeDefined();
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;
    const abortError = createAbortError();
    // The late input lands while the cancelled turn is mid-flight, modelled at
    // the flow's first node-step persist (the only writes carrying a cursor).
    const realWrite = store.write.bind(store);
    let abortFired = false;
    const writeSpy = vi
      .spyOn(store, 'write')
      .mockImplementation(async (key, value) => {
        if (
          !abortFired &&
          value !== null &&
          typeof value === 'object' &&
          'cursor' in value
        ) {
          abortFired = true;
          flowContext?.session.appendFollowUp({
            text: 'late active-turn input',
          });
          flowContext?.interrupt();
          throw abortError;
        }
        return realWrite(key, value);
      });

    try {
      await expect(
        runPersistedFlow(executionId, streamId, snapshot, {
          attachment: {
            attach: (context) => {
              flowContext = context;
            },
          },
          modelHandler: responseModelHandler([]),
          session,
          takePendingFollowUps: () => [],
        }),
      ).rejects.toBe(abortError);
      expect(session.followUps.getAll(streamId)).toEqual([
        'late active-turn input',
      ]);
    } finally {
      writeSpy.mockRestore();
      session.followUps.terminalize(streamId);
    }
  });

  it('leaves a child loop its queued input when the borrowed inner turn is interrupted', async () => {
    // A native subagent's inner turn resumes without `takePendingFollowUps`:
    // the child-run loop owns the queue across all of its turns and releases it
    // with the terminal/recoverable decision. The borrowing flow may cancel its
    // own wait, but dropping the owner's queued items is not its call to make.
    const executionId = 'abc-cancel-child-followup' as ExecutionId;
    const streamId = 'chat@gpt54#abc-cancel-child-followup' as StreamTabId;
    const session = createTestSession();
    const storedShared = activeHandlerShared();
    const snapshot = buildToolUseResumeData(executionId, streamId);
    await writeFlowRecord(executionId, storedShared);
    const childLease = session.followUps.claimLive(streamId, 'child');
    expect(childLease).toBeDefined();
    const store = getExecutionStore(executionId);
    let flowContext: ToolUseSetupContext | undefined;
    const abortError = createAbortError();
    // The queued input lands while the interrupted turn is mid-flight,
    // modelled at the flow's first node-step persist (the only writes
    // carrying a cursor).
    const realWrite = store.write.bind(store);
    let abortFired = false;
    const writeSpy = vi
      .spyOn(store, 'write')
      .mockImplementation(async (key, value) => {
        if (
          !abortFired &&
          value !== null &&
          typeof value === 'object' &&
          'cursor' in value
        ) {
          abortFired = true;
          flowContext?.session.appendFollowUp({ text: 'queued for next turn' });
          flowContext?.interrupt();
          throw abortError;
        }
        return realWrite(key, value);
      });

    try {
      await expect(
        runPersistedFlow(executionId, streamId, snapshot, {
          attachment: {
            attach: (context) => {
              flowContext = context;
            },
          },
          modelHandler: responseModelHandler([]),
          session,
        }),
      ).rejects.toBe(abortError);
      expect(session.followUps.getAll(streamId)).toEqual([
        'queued for next turn',
      ]);
    } finally {
      writeSpy.mockRestore();
      session.followUps.terminalize(streamId);
    }
  });

  it('skips the resume self-heal write when the persisted record is already canonical (issue #8018)', async () => {
    // `resumeToolUseFromResumeData` passes the resume handoff on every
    // native-subagent turn, so the resume-branch self-heal write must not
    // fire when the persisted record already matches what would be
    // written -- otherwise every turn costs a `StorageFSKVStore` disk
    // write for a no-op overwrite of identical bytes.
    const executionId = 'abc143' as ExecutionId;
    const streamId = 'chat@gpt54#abc143' as StreamTabId;
    await writeFlowRecord(
      executionId,
      {
        messages: [{ role: 'user', content: 'Continue.' }],
        continuationGenerationId: '73375bdf-a9db-4d64-a702-3928784bf0e5',
        modelId: 'gpt54',
        modelHandlerCompatibilityKey: ACTIVE_COMPATIBILITY_KEY,
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      WAITING_AT_START,
    );

    const resume = await retrieveToolUseResume(streamId, executionId);
    expect(resume.shared.modelHandlerCompatibilityKey).toBe(
      ACTIVE_COMPATIBILITY_KEY,
    );

    const store = getExecutionStore(executionId);
    const writeSpy = vi.spyOn(store, 'write');
    try {
      await runResumedFlowToWaiting(executionId, streamId, resume);

      // `PersistedFlow` still legitimately persists its own node-cursor
      // progress once as the flow steps through to WAITING -- that write is
      // not under test here. What must NOT happen is a *second*, earlier
      // write from the resume-branch self-heal repairing an already-
      // canonical record. Every write the flow does make must already carry
      // the final WAITING cursor, never the pre-step one the self-heal write
      // would have produced.
      expect(writeSpy.mock.calls.length).toBeGreaterThan(0);
      for (const [, record] of writeSpy.mock.calls) {
        expect((record as FlowRecord).cursor).toEqual({
          lastAction: 'waiting',
          nextNodeId: WAIT_NODE_CURSOR,
        });
      }
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('keeps a persisted snapshot compatibility key authoritative over the active handler', async () => {
    const executionId = 'abc142' as ExecutionId;
    const streamId = 'chat@gpt54#abc142' as StreamTabId;
    const persistedCompatibilityKey = 'ModelHandlerAnthropic';
    await writeFlowRecord(
      executionId,
      {
        messages: [{ role: 'user', content: 'Continue.' }],
        modelHandlerCompatibilityKey: persistedCompatibilityKey,
        continuationGenerationId: CONTINUATION_GENERATION_ID,
        shouldSkipCycle: false,
        stateSlices: defaultStateSlices(),
      },
      WAITING_AT_START,
    );

    const resume = await retrieveToolUseResume(streamId, executionId);
    expect(resume.shared.modelHandlerCompatibilityKey).toBe(
      persistedCompatibilityKey,
    );

    await runResumedFlowToWaiting(executionId, streamId, resume);

    const healedRecord = await readFlowRecord(executionId);
    expect(healedRecord?.shared).toMatchObject({
      modelHandlerCompatibilityKey: persistedCompatibilityKey,
    });
  });

  it('rejects a retired workspace snapshot at the tool-use resume boundary', () => {
    const result = parseToolUseShared({
      ...VALID_TOOL_USE_SHARED,
      stateSlices: {
        runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
        workspaceSnapshot: { todos: [], plan: null },
        userChannels: { input: Object.freeze({}), transient: {} },
      },
    });

    expect(result.success).toBe(false);
  });
});
