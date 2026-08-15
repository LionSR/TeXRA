import { describe, expect, it, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import {
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import { runToolUseFlow } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import {
  createRunContext,
  tryUseRunContext,
  useRunContext,
  withRunContext,
} from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { tryDefaultSession } from '@agent/runtime/SessionHandle';
import type { SdkToolCall } from '@agent/types/ModelHandlerContracts';
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { TodoWriteTool } from '@tools/todo/TodoTool';
import { testModelCell } from './modelCellTestUtils';
import { roundModelHandler } from './toolUseRoundTestUtils';

const CONFIG = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'test-model',
  instruction: 'Use the supplied tools.',
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: process.cwd(),
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
});

function tool(name: string): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    call: vi.fn(),
  };
}

function approvalGatedTool(name: string): ITool {
  return { ...tool(name), requiresApproval: true };
}

describe('run-scoped tool overlay', () => {
  setupPlatform({ workspacePath: process.cwd() });

  it('adds two injected tools and submit_output to the model-facing list', async () => {
    const executionId = '9329abcd' as ExecutionId;
    const streamId = `chat#${executionId}` as StreamTabId;
    const session = createTestSession();
    const runScope = createRunScope({
      executionId,
      streamId,
      agentName: 'chat',
      session,
      signal: new AbortController().signal,
    });
    const warn = vi.fn<typeof noopTrace.warn>();
    const logger = { ...noopTrace, warn };
    const observedTools: { name: string; forceFunctionCall?: boolean }[][] = [];
    const stopAfterObservation = Object.assign(
      new Error('Tool list observed'),
      {
        status: 401,
      },
    );
    const modelHandler = {
      capabilities: { supportsFunctionCalling: true, supportsVision: false },
      config: { provider: 'test' },
      supportsForcedToolChoice: false,
      requiresPerCallSystemPrompt: false,
      initializeMessages: async () => [{ role: 'user', content: 'test' }],
      consumeInsertedAttachmentKinds: () => [],
      getClient: async () => ({}),
      getCredentialRouteForClient: () => undefined,
      setOutputStreaming: () => {},
      getWireRouteKey: () => 'test',
      getModelRetryRouteKey: () => 'test:model',
      extractAssistantText: () => undefined,
      createResponse: async (options: {
        tools?: { name: string; forceFunctionCall?: boolean }[];
      }) => {
        observedTools.push(options.tools ?? []);
        throw stopAfterObservation;
      },
    };
    const modelCell = testModelCell(modelHandler, CONFIG.model);
    // The run context reads the same cell the flow drives, as a launch does.
    const context = createRunContext({ runScope, modelCell });

    try {
      // The model error is recorded as the run's `lastError`, so the flow
      // reports FAILED with it on the result instead of throwing.
      const result = await withRunContext(context, () =>
        runToolUseFlow(
          {
            config: CONFIG,
            runScope,
            setting: AgentToolUseSettingSchema.parse({}),
            prompt: AgentPromptSchema.parse({}),
            logger,
            userVarChannels: {
              input: Object.freeze({ MODEL: CONFIG.model }),
              transient: {},
            },
            modelCell,
            toolPolicy: createToolPolicy(),
            onModelChanged: () => {},
            interrupt: () => {},
            onRoundFinalized: () => {},
            isSubagent: true,
            tools: [tool('first'), tool('second')],
          },
          new MapToolRegistry({ first: tool('first') }),
        ),
      );

      expect(result.outcome).toBe('failed');
      expect(result.error?.message).toContain('Tool list observed');

      expect(observedTools[0]?.map(({ name }) => name)).toEqual([
        'first',
        'second',
        'submit_output',
      ]);
      expect(
        observedTools[0]?.every(({ forceFunctionCall }) => forceFunctionCall),
      ).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        'Run-scoped tool "first" shadows an existing tool.',
      );
    } finally {
      session.dispose();
    }
  });

  it('dispatches and completes a real tool without an ambient run context', async () => {
    const executionId = '9329abcf' as ExecutionId;
    const streamId = `chat#${executionId}` as StreamTabId;
    const session = createTestSession();
    const runScope = createRunScope({
      executionId,
      streamId,
      agentName: 'chat',
      session,
      signal: new AbortController().signal,
    });
    const toolCall: SdkToolCall = {
      provider: 'deepseek',
      callId: 'call-todo-write',
      name: 'todo_write',
      input: {
        todos: [
          {
            content: 'Exercise dispatch',
            activeForm: 'Exercising dispatch',
            status: 'completed',
          },
        ],
      },
      raw: {} as never,
    };
    const responses = [
      { text: '', toolCalls: [toolCall] },
      { text: 'Tool dispatch completed.', toolCalls: [] },
    ];
    const observedToolLists: string[][] = [];
    const observedToolResults: unknown[] = [];
    const progressUpdates: unknown[] = [];
    const dispatchRunContexts: unknown[] = [];
    const modelHandler = roundModelHandler({
      capabilities: { supportsFunctionCalling: true, supportsVision: false },
      requiresPerCallSystemPrompt: false,
      supportsForcedToolChoice: false,
      initializeMessages: async () => [
        { role: 'user', content: 'Update the todo list.' },
      ],
      consumeInsertedAttachmentKinds: () => [],
      createResponse: vi.fn(async (options: { tools?: { name: string }[] }) => {
        observedToolLists.push((options.tools ?? []).map(({ name }) => name));
        const response = responses.shift();
        if (!response) throw new Error('Unexpected model invocation');
        return { response };
      }),
      extractResponse: (response: unknown) => {
        const turn = response as { text: string; toolCalls: SdkToolCall[] };
        return {
          text: turn.text,
          usage: null,
          stopReason: turn.toolCalls.length ? 'tool_use' : 'stop',
        };
      },
      extractToolUse: (response: unknown) =>
        (response as { toolCalls: SdkToolCall[] }).toolCalls,
      createToolUseFollowUpMessages: async (
        _client: unknown,
        call: SdkToolCall,
        result: unknown,
      ) => {
        observedToolResults.push(result);
        return [
          {
            role: 'tool',
            tool_call_id: call.callId,
            content: JSON.stringify(result),
          },
        ];
      },
    });
    const modelCell = testModelCell(modelHandler, 'test-model');
    const config = AgentConfigSchema.parse({
      agent: 'chat',
      model: 'test-model',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: process.cwd(),
    });
    let attachedOwner: unknown;

    try {
      // The test process has no default session, so any currentSession()
      // fallback during dispatch fails instead of silently using another owner.
      expect(tryDefaultSession()).toBeUndefined();
      expect(tryUseRunContext()).toBeUndefined();
      expect(() => useRunContext()).toThrow(/outside withRunContext/);

      const result = await runToolUseFlow(
        {
          config,
          runScope,
          setting: AgentToolUseSettingSchema.parse({
            tools: [{ name: 'bash' }, { name: 'todo_write' }],
          }),
          prompt: AgentPromptSchema.parse({}),
          logger: noopTrace,
          userVarChannels: {
            input: Object.freeze({ MODEL: config.model }),
            transient: {},
          },
          modelCell,
          toolPolicy: createToolPolicy({
            approvalPromptsUnavailable: true,
            stopAfterCycle: true,
          }),
          onModelChanged: () => {},
          interrupt: () => {},
          onRoundFinalized: () => {},
          onProgress: (update) => {
            progressUpdates.push(update);
            if (update.kind === 'todos') {
              // TodoWriteTool emits this synchronously from inside call(), so
              // this observation is made in the real dispatch window.
              dispatchRunContexts.push(tryUseRunContext());
            }
          },
        },
        new MapToolRegistry({
          bash: approvalGatedTool('bash'),
          todo_write: new TodoWriteTool(),
        }),
        {
          attach: ({ ownerSession }) => {
            attachedOwner = ownerSession;
          },
          detach: () => {},
        },
      );

      expect(result).toMatchObject({
        outcome: 'completed',
        response: 'Tool dispatch completed.',
      });
      expect(attachedOwner).toBe(session);
      expect(observedToolLists).toEqual([['todo_write'], ['todo_write']]);
      expect(observedToolResults).toEqual([
        expect.objectContaining({
          status: 'executed',
          output: 'OK',
        }),
      ]);
      expect(dispatchRunContexts).toEqual([undefined]);
      expect(progressUpdates).toContainEqual({
        kind: 'todos',
        todos: [
          {
            content: 'Exercise dispatch',
            activeForm: 'Exercising dispatch',
            status: 'completed',
          },
        ],
      });
      expect(responses).toHaveLength(0);
      expect(tryUseRunContext()).toBeUndefined();
      expect(tryDefaultSession()).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it('filters approval-gated and runtime-unavailable declared tools without a run context', async () => {
    const executionId = '9329abce' as ExecutionId;
    const streamId = `chat#${executionId}` as StreamTabId;
    const session = createTestSession();
    const runScope = createRunScope({
      executionId,
      streamId,
      agentName: 'chat',
      session,
      signal: new AbortController().signal,
    });
    const observedTools: { name: string }[][] = [];
    const stopAfterObservation = Object.assign(
      new Error('Tool list observed'),
      { status: 401 },
    );
    const modelHandler = {
      capabilities: { supportsFunctionCalling: true, supportsVision: false },
      config: { provider: 'test' },
      supportsForcedToolChoice: false,
      requiresPerCallSystemPrompt: false,
      initializeMessages: async () => [{ role: 'user', content: 'test' }],
      consumeInsertedAttachmentKinds: () => [],
      getClient: async () => ({}),
      getCredentialRouteForClient: () => undefined,
      setOutputStreaming: () => {},
      getWireRouteKey: () => 'test',
      getModelRetryRouteKey: () => 'test:model',
      extractAssistantText: () => undefined,
      createResponse: async (options: { tools?: { name: string }[] }) => {
        observedTools.push(options.tools ?? []);
        throw stopAfterObservation;
      },
    };
    const modelCell = testModelCell(modelHandler, 'test-model');
    const config = AgentConfigSchema.parse({
      agent: 'chat',
      model: 'test-model',
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: process.cwd(),
    });

    try {
      // No `withRunContext` frame: `runToolUseFlow` reads `approvalPromptsUnavailable`
      // and `runtimeUnavailableTools` from the injected `toolPolicy`, not the ALS.
      const result = await runToolUseFlow(
        {
          config,
          runScope,
          setting: AgentToolUseSettingSchema.parse({
            tools: [
              { name: 'bash' },
              { name: 'grep' },
              { name: 'inquiry' },
              { name: 'write_file' },
              { name: 'wolfram' },
            ],
          }),
          prompt: AgentPromptSchema.parse({}),
          logger: noopTrace,
          userVarChannels: {
            input: Object.freeze({ MODEL: config.model }),
            transient: {},
          },
          modelCell,
          toolPolicy: createToolPolicy({
            approvalPromptsUnavailable: true,
            runtimeUnavailableTools: ['inquiry'],
          }),
          onModelChanged: () => {},
          interrupt: () => {},
          onRoundFinalized: () => {},
          isSubagent: true,
        },
        new MapToolRegistry({
          bash: approvalGatedTool('bash'),
          grep: tool('grep'),
          inquiry: approvalGatedTool('inquiry'),
          write_file: approvalGatedTool('write_file'),
          wolfram: approvalGatedTool('wolfram'),
        }),
      );

      expect(result.outcome).toBe('failed');
      expect(observedTools[0]?.map(({ name }) => name)).toEqual(['grep']);
    } finally {
      session.dispose();
    }
  });
});
