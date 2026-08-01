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
import { testModelCell } from '../modelCellTestUtils';

type FunctionCallMessage = { type: string; call_id: string };

/**
 * A three-tool round driven by the run's own interrupt controller — the same
 * single owner production wires in — so a scenario picks where the run is
 * stopped by choosing what aborts it, not by counting internal checks.
 *
 * `'tool-call-extraction'` aborts while the model response is being
 * processed, so the round reaches dispatch with tool calls pending and
 * `prep()` stops it; `'tool-b'` aborts from inside the second tool, so call-a
 * finishes normally, call-b is aborted mid-flight, and call-c never starts.
 */
function createRoundFixture(abortOn: 'tool-call-extraction' | 'tool-b') {
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(new DOMException('Run interrupted', 'AbortError'));

  const toolACall = vi.fn(async () => ({
    status: 'executed' as const,
    output: 'toolA done',
  }));
  const toolBCall = vi.fn(async () => {
    if (abortOn === 'tool-b') abort();
    return { status: 'executed' as const, output: 'toolB done' };
  });
  const toolCCall = vi.fn(async () => ({
    status: 'executed' as const,
    output: 'toolC done',
  }));

  const createResponse = vi.fn(async () => ({
    response: { id: 'round-1', toolCalls: true },
  }));

  const services = {
    ...baseRoundServices('ToolUseDispatchInterruption'),
    abortSignal: controller.signal,
    checkInterruption: () => controller.signal.aborted,
    modelCell: testModelCell(
      roundModelHandler({
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
        extractToolUse: (response: { toolCalls?: boolean }) => {
          if (abortOn === 'tool-call-extraction') abort();
          return response.toolCalls
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
                {
                  callId: 'call-c',
                  input: {},
                  name: 'toolC',
                  provider: 'test',
                  raw: {},
                },
              ]
            : [];
        },
      }),
    ),
    session: {
      hasQueuedFollowUp: () => false,
    },
    setting: {
      temperature: 0,
      tools: [{ name: 'toolA' }, { name: 'toolB' }, { name: 'toolC' }],
    },
    toolRegistry: new MapToolRegistry({
      toolA: { call: toolACall, definition: { name: 'toolA' } } as never,
      toolB: { call: toolBCall, definition: { name: 'toolB' } } as never,
      toolC: { call: toolCCall, definition: { name: 'toolC' } } as never,
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

  return { createResponse, services, shared, toolACall, toolBCall, toolCCall };
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
  it('synthesizes cancelled tool_results for the calls aborted mid-round, keeping tool_use/tool_result counts paired', async () => {
    // call-a completes before anything aborts, call-b aborts the run from
    // inside the tool, and call-c never starts.
    const {
      createResponse,
      services,
      shared,
      toolACall,
      toolBCall,
      toolCCall,
    } = createRoundFixture('tool-b');

    await runRound(services, shared);

    // Only one round was attempted — the loop stopped after interruption
    // rather than calling the model again.
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(toolACall).toHaveBeenCalledTimes(1);
    expect(toolBCall).toHaveBeenCalledTimes(1);
    expect(toolCCall).not.toHaveBeenCalled();
    expect(shared.shouldStop).toBe(true);

    const functionCalls = messagesOfType(shared, 'function_call');
    const functionResults = messagesOfType(shared, 'function_call_output');

    // Every tool_use block the model requested must be paired with a
    // tool_result, even though only one of them kept a real result.
    expect(functionCalls).toHaveLength(3);
    expect(functionResults).toHaveLength(3);
    expect(functionCalls.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);
    expect(functionResults.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);

    // The call that finished before the interrupt keeps its real output.
    const executedResult = functionResults.find((m) => m.call_id === 'call-a');
    expect(executedResult?.output).toContain('toolA done');

    // Aborted mid-flight and never started both surface as cancelled.
    for (const callId of ['call-b', 'call-c']) {
      const cancelledResult = functionResults.find((m) => m.call_id === callId);
      expect(cancelledResult?.output).toContain('"status":"error"');
      expect(cancelledResult?.output.toLowerCase()).toContain('cancelled');
    }
  });

  it('synthesizes cancelled tool_results for every requested call when interruption is detected in dispatch prep() before any call executes', async () => {
    // The model call completes and its tool calls are extracted, then the run
    // is interrupted — so ToolUseDispatchNode.prep()'s own check stops the
    // round before any call is dispatched.
    const {
      createResponse,
      services,
      shared,
      toolACall,
      toolBCall,
      toolCCall,
    } = createRoundFixture('tool-call-extraction');

    await runRound(services, shared);

    // Only one round was attempted, and no tool call ever executed —
    // dispatch prep() caught the interruption before exec() ran for any.
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(toolACall).not.toHaveBeenCalled();
    expect(toolBCall).not.toHaveBeenCalled();
    expect(toolCCall).not.toHaveBeenCalled();
    expect(shared.shouldStop).toBe(true);
    // The pending calls must be cleared, not left dangling on shared state.
    expect(shared.toolCalls).toEqual([]);

    const functionCalls = messagesOfType(shared, 'function_call');
    const functionResults = messagesOfType(shared, 'function_call_output');

    // Every tool_use block the model requested must still be paired with a
    // tool_result, even though prep() never dispatched any of them.
    expect(functionCalls).toHaveLength(3);
    expect(functionResults).toHaveLength(3);
    expect(functionCalls.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);
    expect(functionResults.map((m) => m.call_id).sort()).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);

    for (const callId of ['call-a', 'call-b', 'call-c']) {
      const cancelledResult = functionResults.find((m) => m.call_id === callId);
      expect(cancelledResult?.output).toContain('"status":"error"');
      expect(cancelledResult?.output.toLowerCase()).toContain('cancelled');
    }
  });
});
