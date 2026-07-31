// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProviderMessage } from '@agent/types/ProviderMessage';

// Local file imports
import { withTestRunContext } from '../progressTestUtils';
import { baseRoundServices, roundModelHandler } from '../toolUseRoundTestUtils';

type FunctionCallMessage = { type: string; call_id: string };

/**
 * A two-tool round whose `checkInterruption` reports "not interrupted" for
 * the first `interruptAfterCheck` calls and "interrupted" from then on, so a
 * scenario picks exactly where in the dispatch sequence the run is stopped.
 */
function createRoundFixture(interruptAfterCheck: number) {
  let checkCount = 0;
  const checkInterruption = vi.fn(() => {
    checkCount += 1;
    return checkCount > interruptAfterCheck;
  });

  const toolACall = vi.fn(async () => ({
    status: 'executed' as const,
    output: 'toolA done',
  }));
  const toolBCall = vi.fn(async () => ({
    status: 'executed' as const,
    output: 'toolB done',
  }));

  const createResponse = vi.fn(async () => ({
    response: { id: 'round-1', toolCalls: true },
  }));

  const services = {
    ...baseRoundServices('ToolUseDispatchInterruption'),
    checkInterruption,
    modelHandler: roundModelHandler({
      createResponse,
      createToolUseFollowUpMessages: vi.fn(
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
      ),
      createUserFollowUpMessages: vi.fn(),
      extractResponse: (response: { toolCalls?: boolean }) => ({
        text: '',
        usage: null,
        stopReason: response.toolCalls ? 'tool_calls' : 'stop',
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
    }),
    session: {
      hasQueuedFollowUp: () => false,
    },
    setting: {
      temperature: 0,
      tools: [{ name: 'toolA' }, { name: 'toolB' }],
    },
    toolRegistry: new MapToolRegistry({
      toolA: { call: toolACall, definition: { name: 'toolA' } } as never,
      toolB: { call: toolBCall, definition: { name: 'toolB' } } as never,
    }),
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

  return { createResponse, services, shared, toolACall, toolBCall };
}

function runRound(
  services: ToolUseRoundServices,
  shared: ToolUseRoundShared,
): Promise<string | undefined> {
  const { session } = services.runScope;
  return withTestRunContext(
    session.interactions,
    'test-stream',
    () => createToolUseRoundFlow().setServices(services).run(shared),
    { session },
  );
}

function messagesOfType(
  shared: ToolUseRoundShared,
  type: string,
): (FunctionCallMessage & { output: string })[] {
  return shared.messages.filter(
    (message) => (message as FunctionCallMessage).type === type,
  ) as unknown as (FunctionCallMessage & { output: string })[];
}

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
 * Each test dispatches two tool calls in one round, interrupts the run at a
 * different point, and asserts the persisted messages contain a matching
 * tool_use/tool_result pair for *both* calls — the pairs for the calls that
 * never ran being synthesized "cancelled" results.
 */
describe('ToolUseDispatchNode interruption', () => {
  it('synthesizes a cancelled tool_result for a call skipped mid-round, keeping tool_use/tool_result counts paired', async () => {
    // Checks 1-4 (round prep, dispatch prep, call-a's pre-dispatch check,
    // call-a's post-invoke check) report "not interrupted" so call-a runs
    // to completion. From call-b's pre-dispatch check (5) onward,
    // interruption is detected — call-b never executes.
    const { createResponse, services, shared, toolACall, toolBCall } =
      createRoundFixture(4);

    await runRound(services, shared);

    // Only one round was attempted — the loop stopped after interruption
    // rather than calling the model again.
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(toolACall).toHaveBeenCalledTimes(1);
    expect(toolBCall).not.toHaveBeenCalled();
    expect(shared.shouldStop).toBe(true);

    const functionCalls = messagesOfType(shared, 'function_call');
    const functionResults = messagesOfType(shared, 'function_call_output');

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
    // Check 1 is ToolUseRoundPrepNode's pre-model-call check (not
    // interrupted, so the model call proceeds and returns two tool calls).
    // Check 2 is ToolUseDispatchNode.prep()'s own check, which now reports
    // interrupted — before either call is dispatched. `exec()` is never
    // invoked for call-a or call-b in this scenario.
    const { createResponse, services, shared, toolACall, toolBCall } =
      createRoundFixture(1);

    await runRound(services, shared);

    // Only one round was attempted, and neither tool call ever executed —
    // dispatch prep() caught the interruption before exec() ran for either.
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(toolACall).not.toHaveBeenCalled();
    expect(toolBCall).not.toHaveBeenCalled();
    expect(shared.shouldStop).toBe(true);
    // The pending calls must be cleared, not left dangling on shared state.
    expect(shared.toolCalls).toEqual([]);

    const functionCalls = messagesOfType(shared, 'function_call');
    const functionResults = messagesOfType(shared, 'function_call_output');

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
