// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent core
import { createRunTrace, StreamLogStore } from '@transcript';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { withTestRunContext } from '../progressTestUtils';

/**
 * Regression test for https://github.com/LionSR/TeXRA/issues/7163.
 *
 * When a tool-use round is interrupted mid-flight, `ToolUseDispatchNode` used
 * to silently drop the tool_use blocks for calls that never executed —
 * persisting an assistant turn with N tool_use blocks but fewer than N
 * tool_result entries. Providers with strict tool-call pairing requirements
 * (e.g. Anthropic, and OpenAI's response-chaining mode) reject a follow-up
 * request whose history has an unpaired tool_use on resume.
 *
 * This test dispatches two tool calls in one round, interrupts the run
 * between the first call finishing and the second call starting, and asserts
 * the persisted messages contain a matching tool_use/tool_result pair for
 * *both* calls — the second pair being a synthesized "cancelled" result.
 */
describe('ToolUseDispatchNode interruption', () => {
  it('synthesizes a cancelled tool_result for a call skipped mid-round, keeping tool_use/tool_result counts paired', async () => {
    let checkCount = 0;
    const checkInterruption = vi.fn(() => {
      checkCount += 1;
      // Checks 1-4 (round prep, dispatch prep, call-a's pre-dispatch check,
      // call-a's post-invoke check) report "not interrupted" so call-a runs
      // to completion. From call-b's pre-dispatch check (5) onward,
      // interruption is detected — call-b never executes.
      return checkCount > 4;
    });

    const toolACall = vi.fn(async () => ({
      status: 'executed' as const,
      output: 'toolA done',
    }));
    const toolBCall = vi.fn(async () => ({
      status: 'executed' as const,
      output: 'toolB done',
    }));

    const createToolUseFollowUpMessages = vi.fn(
      async (
        _client: unknown,
        call: { callId: string; name: string },
        result: unknown,
      ) =>
        [
          {
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: '{}',
          },
          {
            type: 'function_call_output',
            call_id: call.callId,
            output: JSON.stringify(result),
          },
        ] as ProviderMessage[],
    );

    const createResponse = vi.fn(async () => ({
      response: { id: 'round-1', toolCalls: true },
    }));

    const services = {
      checkInterruption,
      client: {},
      config: { agent: 'test-agent', model: 'test-model' },
      fileService: {
        createLocation: (filePath: string) => ({ absolutePath: filePath }),
      },
      logger: createRunTrace(
        'ToolUseDispatchInterruption',
        StreamLogStore.ephemeral('test'),
      ).trace,
      modelHandler: {
        addMediaToUserMessage: vi.fn(async () => []),
        capabilities: { supportsVision: true },
        createAssistantMessageFromResponse: vi.fn(
          (_response: unknown, text: string) =>
            ({ type: 'message', role: 'assistant', content: text }) as never,
        ),
        createResponse,
        createToolUseFollowUpMessages,
        createUserFollowUpMessages: vi.fn(),
        extractAssistantContent: () => [],
        extractResponse: (response: { toolCalls?: boolean }) => ({
          text: '',
          usage: null,
          stopReason: response.toolCalls ? 'tool_calls' : 'stop',
        }),
        extractServerToolData: () => ({
          contentBlocks: [],
          webFetchResults: [],
          webSearchResults: [],
        }),
        extractToolUse: (response: { toolCalls?: boolean }) =>
          response.toolCalls
            ? [
                {
                  callId: 'call-a',
                  input: {},
                  name: 'toolA',
                  provider: 'test',
                  raw: {},
                },
                {
                  callId: 'call-b',
                  input: {},
                  name: 'toolB',
                  provider: 'test',
                  raw: {},
                },
              ]
            : [],
        getStreamingConfig: () => false,
        isEndTurnStop: (stopReason: string) => stopReason === 'stop',
        processThinkingBlock: () => null,
        setOutputStreaming: vi.fn(),
      },
      prompt: { systemPrompt: '', userPrefix: '', userRequest: '' },
      run: AgentRunStateSnapshotSchema.parse({}),
      session: {
        hasQueuedFollowUp: () => false,
      },
      setAbortController: () => {},
      setting: {
        temperature: 0,
        tools: [{ name: 'toolA' }, { name: 'toolB' }],
      },
      streamStatus: new StreamStatusMachine(),
      toolRegistry: new MapToolRegistry({
        toolA: { call: toolACall, definition: { name: 'toolA' } } as never,
        toolB: { call: toolBCall, definition: { name: 'toolB' } } as never,
      }),
      userVarChannels: { input: {}, transient: {} },
      workspace: AgentWorkspaceState.create(),
    } as unknown as ToolUseRoundServices;

    const shared: ToolUseRoundShared = {
      messages: [],
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      roundIndex: 0,
      roundResponseTimeMs: 0,
      roundNormalizedUsage: undefined,
    };

    await withTestRunContext(noopAgentRuntimeHost, 'test-stream', () =>
      createToolUseRoundFlow().setServices(services).run(shared),
    );

    // Only one round was attempted — the loop stopped after interruption
    // rather than calling the model again.
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(toolACall).toHaveBeenCalledTimes(1);
    expect(toolBCall).not.toHaveBeenCalled();
    expect(shared.shouldStop).toBe(true);

    type FunctionCallMessage = { type: string; call_id: string };
    const functionCalls = shared.messages.filter(
      (m) => (m as FunctionCallMessage).type === 'function_call',
    ) as unknown as FunctionCallMessage[];
    const functionResults = shared.messages.filter(
      (m) => (m as FunctionCallMessage).type === 'function_call_output',
    ) as unknown as (FunctionCallMessage & { output: string })[];

    // Both tool_use blocks the model requested must be paired with a
    // tool_result, even though only one of them actually executed.
    expect(functionCalls).toHaveLength(2);
    expect(functionResults).toHaveLength(2);
    expect(functionCalls.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
    ]);
    expect(functionResults.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
    ]);

    const cancelledResult = functionResults.find((m) => m.call_id === 'call-b');
    expect(cancelledResult?.output).toContain('"status":"error"');
    expect(cancelledResult?.output.toLowerCase()).toContain('cancelled');
  });

  it('synthesizes cancelled tool_results for every requested call when interruption is detected in dispatch prep() before any call executes', async () => {
    let checkCount = 0;
    const checkInterruption = vi.fn(() => {
      checkCount += 1;
      // Check 1 is ToolUseRoundPrepNode's pre-model-call check (not
      // interrupted, so the model call proceeds and returns two tool calls).
      // Check 2 is ToolUseDispatchNode.prep()'s own check, which now reports
      // interrupted — before either call is dispatched. `exec()` is never
      // invoked for call-a or call-b in this scenario.
      return checkCount > 1;
    });

    const toolACall = vi.fn(async () => ({
      status: 'executed' as const,
      output: 'toolA done',
    }));
    const toolBCall = vi.fn(async () => ({
      status: 'executed' as const,
      output: 'toolB done',
    }));

    const createToolUseFollowUpMessages = vi.fn(
      async (
        _client: unknown,
        call: { callId: string; name: string },
        result: unknown,
      ) =>
        [
          {
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: '{}',
          },
          {
            type: 'function_call_output',
            call_id: call.callId,
            output: JSON.stringify(result),
          },
        ] as ProviderMessage[],
    );

    const createResponse = vi.fn(async () => ({
      response: { id: 'round-1', toolCalls: true },
    }));

    const services = {
      checkInterruption,
      client: {},
      config: { agent: 'test-agent', model: 'test-model' },
      fileService: {
        createLocation: (filePath: string) => ({ absolutePath: filePath }),
      },
      logger: createRunTrace(
        'ToolUseDispatchInterruption',
        StreamLogStore.ephemeral('test'),
      ).trace,
      modelHandler: {
        addMediaToUserMessage: vi.fn(async () => []),
        capabilities: { supportsVision: true },
        createAssistantMessageFromResponse: vi.fn(
          (_response: unknown, text: string) =>
            ({ type: 'message', role: 'assistant', content: text }) as never,
        ),
        createResponse,
        createToolUseFollowUpMessages,
        createUserFollowUpMessages: vi.fn(),
        extractAssistantContent: () => [],
        extractResponse: (response: { toolCalls?: boolean }) => ({
          text: '',
          usage: null,
          stopReason: response.toolCalls ? 'tool_calls' : 'stop',
        }),
        extractServerToolData: () => ({
          contentBlocks: [],
          webFetchResults: [],
          webSearchResults: [],
        }),
        extractToolUse: (response: { toolCalls?: boolean }) =>
          response.toolCalls
            ? [
                {
                  callId: 'call-a',
                  input: {},
                  name: 'toolA',
                  provider: 'test',
                  raw: {},
                },
                {
                  callId: 'call-b',
                  input: {},
                  name: 'toolB',
                  provider: 'test',
                  raw: {},
                },
              ]
            : [],
        getStreamingConfig: () => false,
        isEndTurnStop: (stopReason: string) => stopReason === 'stop',
        processThinkingBlock: () => null,
        setOutputStreaming: vi.fn(),
      },
      prompt: { systemPrompt: '', userPrefix: '', userRequest: '' },
      run: AgentRunStateSnapshotSchema.parse({}),
      session: {
        hasQueuedFollowUp: () => false,
      },
      setAbortController: () => {},
      setting: {
        temperature: 0,
        tools: [{ name: 'toolA' }, { name: 'toolB' }],
      },
      streamStatus: new StreamStatusMachine(),
      toolRegistry: new MapToolRegistry({
        toolA: { call: toolACall, definition: { name: 'toolA' } } as never,
        toolB: { call: toolBCall, definition: { name: 'toolB' } } as never,
      }),
      userVarChannels: { input: {}, transient: {} },
      workspace: AgentWorkspaceState.create(),
    } as unknown as ToolUseRoundServices;

    const shared: ToolUseRoundShared = {
      messages: [],
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      roundIndex: 0,
      roundResponseTimeMs: 0,
      roundNormalizedUsage: undefined,
    };

    await withTestRunContext(noopAgentRuntimeHost, 'test-stream', () =>
      createToolUseRoundFlow().setServices(services).run(shared),
    );

    // Only one round was attempted, and neither tool call ever executed —
    // dispatch prep() caught the interruption before exec() ran for either.
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(toolACall).not.toHaveBeenCalled();
    expect(toolBCall).not.toHaveBeenCalled();
    expect(shared.shouldStop).toBe(true);
    // The pending calls must be cleared, not left dangling on shared state.
    expect(shared.toolCalls).toEqual([]);

    type FunctionCallMessage = { type: string; call_id: string };
    const functionCalls = shared.messages.filter(
      (m) => (m as FunctionCallMessage).type === 'function_call',
    ) as unknown as FunctionCallMessage[];
    const functionResults = shared.messages.filter(
      (m) => (m as FunctionCallMessage).type === 'function_call_output',
    ) as unknown as (FunctionCallMessage & { output: string })[];

    // Both tool_use blocks the model requested must still be paired with a
    // tool_result, even though prep() never dispatched either of them.
    expect(functionCalls).toHaveLength(2);
    expect(functionResults).toHaveLength(2);
    expect(functionCalls.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
    ]);
    expect(functionResults.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
    ]);

    for (const callId of ['call-a', 'call-b']) {
      const cancelledResult = functionResults.find((m) => m.call_id === callId);
      expect(cancelledResult?.output).toContain('"status":"error"');
      expect(cancelledResult?.output.toLowerCase()).toContain('cancelled');
    }
  });
});
