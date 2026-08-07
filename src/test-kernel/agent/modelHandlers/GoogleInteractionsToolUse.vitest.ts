// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import type { GoogleToolCall } from '@agent/types/ModelHandlerContracts';
import type { ToolResult } from '@shared/schemas/toolResult';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';

// Local file imports
import {
  fakeWorkspace,
  GOOGLE_INTERACTIONS_TEST_CONFIG,
  StreamingGoogleInteractionsHandler,
} from './googleInteractionsTestUtils';
import type { Interactions } from '@google/genai';

const originalGetConfig = configModule.getConfig;

/** Pin the server-state setting OFF so the stateless wire shape is exercised. */
function disableServerState(): void {
  vi.spyOn(configModule, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T => {
      if (key === 'texra.model.useGoogleInteractionsServerState') {
        return false as T;
      }
      return originalGetConfig(key, defaultValue);
    },
  );
}

type Step = Interactions.Step;
type SSEEvent = Interactions.InteractionSSEEvent;
type CreateParams = Interactions.CreateModelInteractionParamsStreaming;

function createHandler(): ModelHandlerGoogleInteractions {
  const handler = new StreamingGoogleInteractionsHandler(
    buildTestModelConfig(GOOGLE_INTERACTIONS_TEST_CONFIG, {
      capabilities: { supportsTokenCounting: false },
    }),
  );
  handler.setLogger({ ...noopTrace });
  return handler;
}

/** Fake client yielding a canned SSE stream, recording each request into
 * `calls` so tests can assert the wire shape the handler sent. */
function fakeClient(events: SSEEvent[], calls: CreateParams[] = []): unknown {
  return {
    interactions: {
      create: async (params: CreateParams) => {
        calls.push(params);
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
    models: {},
  };
}

/** A signed thought step: summary text then its signature. */
function thoughtEvents(index: number, signature: string): SSEEvent[] {
  return [
    { event_type: 'step.start', index, step: { type: 'thought' } },
    {
      event_type: 'step.delta',
      index,
      delta: {
        type: 'thought_summary',
        content: { type: 'text', text: 'plan' },
      },
    },
    {
      event_type: 'step.delta',
      index,
      delta: { type: 'thought_signature', signature },
    },
    { event_type: 'step.stop', index },
  ];
}

/** A function_call step whose arguments arrive as one or more streamed deltas. */
function callEvents(
  index: number,
  id: string,
  name: string,
  ...argumentDeltas: string[]
): SSEEvent[] {
  return [
    {
      event_type: 'step.start',
      index,
      step: { type: 'function_call', id, name, arguments: {} },
    },
    ...argumentDeltas.map((args): SSEEvent => ({
      event_type: 'step.delta',
      index,
      delta: { type: 'arguments_delta', arguments: args },
    })),
    { event_type: 'step.stop', index },
  ];
}

function completedEvent(
  id: string,
  status: 'completed' | 'requires_action',
  steps?: Step[],
): SSEEvent {
  return {
    event_type: 'interaction.completed',
    interaction: { id, status, ...(steps ? { steps } : {}) },
  };
}

/** Drive a single `createResponse` round from a canned SSE event list, using
 * the single-turn "go" user message every non-store:false test in this file
 * sends. */
function createGoResponse(
  handler: ModelHandlerGoogleInteractions,
  events: SSEEvent[],
) {
  return handler.createResponse({
    client: fakeClient(events) as never,
    messages: [{ type: 'user_input', content: [{ type: 'text', text: 'go' }] }],
    temperature: 0,
    tools: [],
  });
}

describe('ModelHandlerGoogleInteractions tool use', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps finalTool to the Interactions generation config', async () => {
    disableServerState();
    const handler = createHandler();
    const calls: CreateParams[] = [];
    const client = fakeClient(
      [completedEvent('int_final', 'completed', [])],
      calls,
    );

    await handler.createResponse({
      client: client as never,
      messages: [
        { type: 'user_input', content: [{ type: 'text', text: 'finish' }] },
      ],
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
      finalTool: { name: 'submit_output' },
    });

    expect(calls[0]?.generation_config?.tool_choice).toBe('submit_output');
    expect(handler.supportsForcedToolChoice).toBe(true);
  });

  it('sends only Google-supported numeric constraints', async () => {
    const handler = createHandler();
    const calls: CreateParams[] = [];
    const client = fakeClient(
      [completedEvent('int_schema', 'completed', [])],
      calls,
    );

    await handler.createResponse({
      client: client as never,
      messages: [
        { type: 'user_input', content: [{ type: 'text', text: 'count' }] },
      ],
      temperature: 0,
      tools: [
        {
          name: 'bounded_counts',
          zodSchema: z.strictObject({
            integer: z.int().positive().lt(10),
            number: z.number().positive().lt(10),
          }),
        },
      ],
    });

    const interactionTool = calls[0]?.tools?.[0] as
      { parameters?: unknown } | undefined;
    const parameters = interactionTool?.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(parameters.properties.integer).toStrictEqual({
      type: 'integer',
      minimum: 1,
      maximum: 9,
    });
    expect(parameters.properties.number).toStrictEqual({
      type: 'number',
      minimum: 0,
      maximum: 10,
    });
    expect(JSON.stringify(parameters)).not.toContain('exclusive');
  });

  it('accumulates parallel arguments_delta chunks and extracts tool calls', async () => {
    const handler = createHandler();

    const events: SSEEvent[] = [
      ...callEvents(0, 'call_1', 'search', '{"q":', '"x"}'),
      ...callEvents(1, 'call_2', 'fetch', '{"u":"y"}'),
      {
        event_type: 'interaction.status_update',
        interaction_id: 'int_1',
        status: 'requires_action',
      },
      completedEvent('int_1', 'requires_action'),
    ];

    const result = await createGoResponse(handler, events);

    const calls = handler.extractToolUse(result.response);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      callId: 'call_1',
      name: 'search',
      input: { q: 'x' },
    });
    expect(calls[1]).toMatchObject({
      callId: 'call_2',
      name: 'fetch',
      input: { u: 'y' },
    });
  });

  it('round-trips the model-generated thought + function_call steps the handler actually produced', async () => {
    const handler = createHandler();

    // A real streamed turn: a signed thought, then a function call.
    const events: SSEEvent[] = [
      ...thoughtEvents(0, 'sig_abc'),
      ...callEvents(1, 'call_1', 'search', '{"q":"x"}'),
      completedEvent('int_1', 'requires_action'),
    ];

    const workspace = fakeWorkspace();
    const response = (await createGoResponse(handler, events)).response;

    // Mirror the cycle: reasoning is captured into the workspace before dispatch.
    handler.processThinkingBlock(response, workspace);
    const [call] = handler.extractToolUse(response);
    expect(call).toMatchObject({
      callId: 'call_1',
      name: 'search',
      input: { q: 'x' },
    });

    const result: ToolResult = {
      status: 'executed',
      output: 'found it',
    };
    const followUp = await handler.createToolUseFollowUpMessages(
      undefined,
      call,
      result,
      [
        {
          path: 'img.png',
          mimeType: 'image/png',
          base64Data: Buffer.from('img-bytes').toString('base64'),
        } as never,
      ],
      workspace,
    );

    // The handler must itself rebuild the assistant turn — thought (with its
    // signature) + function_call — BEFORE the function_result, so the stateless
    // round-trip is valid and the signature survives for backend validation.
    expect(followUp.map((s) => s.type)).toEqual([
      'thought',
      'function_call',
      'function_result',
    ]);

    const thought = followUp[0] as Extract<Step, { type: 'thought' }>;
    expect(thought.signature).toBe('sig_abc');

    const fnCall = followUp[1] as Extract<Step, { type: 'function_call' }>;
    expect(fnCall).toMatchObject({
      id: 'call_1',
      name: 'search',
      arguments: { q: 'x' },
    });

    const resultStep = followUp[2] as Extract<
      Step,
      { type: 'function_result' }
    >;
    expect(resultStep.call_id).toBe('call_1');
    const subcontent = resultStep.result as Array<{ type: string }>;
    expect(subcontent[0]?.type).toBe('text');
    expect(subcontent.some((c) => c.type === 'image')).toBe(true);

    // Stateless: reasoning is consumed (reset) so it is not re-emitted next round.
    expect(workspace.reasoning.thinkingBlocks).toHaveLength(0);
  });

  it('batches parallel calls: all function_call steps precede all function_result steps', async () => {
    const handler = createHandler();
    expect(handler.requiresBatchedParallelToolResults).toBe(true);

    const calls: GoogleToolCall[] = [
      {
        provider: 'google',
        callId: 'call_1',
        name: 'search',
        input: { q: 'x' },
        raw: { id: 'call_1', name: 'search', args: { q: 'x' } },
      },
      {
        provider: 'google',
        callId: 'call_2',
        name: 'fetch',
        input: { u: 'y' },
        raw: { id: 'call_2', name: 'fetch', args: { u: 'y' } },
      },
    ];
    const results: ToolResult[] = [
      { status: 'executed', output: 'a' },
      { status: 'executed', output: 'b' },
    ];

    // Seed a signed thought + assistant text for this turn so the full
    // model-emitted ordering is exercised (thought -> text -> calls -> results).
    const workspace = fakeWorkspace();
    workspace.reasoning.thinkingBlocks = [
      { type: 'thinking', thinking: 'plan', signature: 'sig_b' },
    ];

    const followUp = await handler.createBatchedToolUseFollowUpMessages!(
      calls.map((call, index) => ({
        call,
        result: results[index],
        attachments: [],
      })),
      workspace,
      'thinking done',
    );

    expect(followUp.map((s) => s.type)).toEqual([
      'thought',
      'model_output',
      'function_call',
      'function_call',
      'function_result',
      'function_result',
    ]);
    const thought = followUp[0] as Extract<Step, { type: 'thought' }>;
    expect(thought.signature).toBe('sig_b');
    const callIds = followUp
      .filter(
        (s): s is Extract<Step, { type: 'function_call' }> =>
          s.type === 'function_call',
      )
      .map((s) => s.id);
    expect(callIds).toEqual(['call_1', 'call_2']);
    // Reasoning is consumed (reset) so it is not re-emitted next round.
    expect(workspace.reasoning.thinkingBlocks).toHaveLength(0);
  });

  it('returns empty arguments when streamed tool args are malformed JSON', async () => {
    const handler = createHandler();
    const events: SSEEvent[] = [
      ...callEvents(0, 'call_x', 'bad', 'not json {'),
      completedEvent('int_1', 'requires_action'),
    ];

    const result = await createGoResponse(handler, events);

    const calls = handler.extractToolUse(result.response);
    expect(calls).toHaveLength(1);
    // Malformed args fall back to an empty object rather than throwing.
    expect(calls[0]).toMatchObject({
      callId: 'call_x',
      name: 'bad',
      input: {},
    });
  });

  it('prefers streamed steps when completed steps omit delta-only fields', async () => {
    const handler = createHandler();
    const events: SSEEvent[] = [
      ...thoughtEvents(0, 'sig_streamed'),
      ...callEvents(1, 'call_1', 'search', '{"q":"streamed"}'),
      // The completed steps omit the signature and the streamed arguments.
      completedEvent('int_1', 'requires_action', [
        { type: 'thought', summary: [{ type: 'text', text: 'plan' }] },
        {
          type: 'function_call',
          id: 'call_1',
          name: 'search',
          arguments: {},
        },
      ]),
    ];

    const response = (await createGoResponse(handler, events)).response;

    const workspace = fakeWorkspace();
    handler.processThinkingBlock(response, workspace);
    expect(workspace.reasoning.thinkingBlocks[0]?.signature).toBe(
      'sig_streamed',
    );

    expect(handler.extractToolUse(response)[0]).toMatchObject({
      callId: 'call_1',
      name: 'search',
      input: { q: 'streamed' },
    });
  });

  it('resends the full prior step history verbatim on the next request (store:false, no previous_interaction_id)', async () => {
    // The stateless wire shape is now opt-in (server-side state defaults ON).
    disableServerState();
    const handler = createHandler();
    const workspace = fakeWorkspace();

    // --- Turn 1: a signed thought + a function call. ---
    const turn1: SSEEvent[] = [
      ...thoughtEvents(0, 'sig_abc'),
      ...callEvents(1, 'call_1', 'search', '{"q":"x"}'),
      completedEvent('int_1', 'requires_action'),
    ];

    const messages: Step[] = [
      { type: 'user_input', content: [{ type: 'text', text: 'go' }] },
    ];
    const resp1 = (
      await handler.createResponse({
        client: fakeClient(turn1) as never,
        messages,
        temperature: 0,
        tools: [],
      })
    ).response;

    // The cycle records the assistant turn ONLY through the follow-up return
    // value, so it must carry the model-generated steps. Append them as the flow
    // (ToolUseDispatchNode) does.
    handler.processThinkingBlock(resp1, workspace);
    const [call] = handler.extractToolUse(resp1);
    const followUp = await handler.createToolUseFollowUpMessages(
      undefined,
      call,
      { status: 'executed', output: 'ok' },
      [],
      workspace,
    );
    messages.push(...followUp);

    // --- Turn 2: capture exactly what the handler sends. ---
    const calls: CreateParams[] = [];
    const capturingClient = fakeClient(
      [
        completedEvent('int_2', 'completed', [
          { type: 'model_output', content: [{ type: 'text', text: 'done' }] },
        ]),
      ],
      calls,
    );

    await handler.createResponse({
      client: capturingClient as never,
      messages,
      temperature: 0,
      tools: [],
    });

    const captured = calls[0];
    expect(captured).toBeDefined();
    expect(captured.store).toBe(false);
    expect(
      (captured as { previous_interaction_id?: string })
        .previous_interaction_id,
    ).toBeUndefined();

    // The entire prior transcript is resent verbatim as `input`.
    const input = captured.input as Step[];
    expect(input.map((s) => s.type)).toEqual([
      'user_input',
      'thought',
      'function_call',
      'function_result',
    ]);
    const thought = input[1] as Extract<Step, { type: 'thought' }>;
    expect(thought.signature).toBe('sig_abc');
    const fnCall = input[2] as Extract<Step, { type: 'function_call' }>;
    expect(fnCall).toMatchObject({
      id: 'call_1',
      name: 'search',
      arguments: { q: 'x' },
    });
  });
});
