// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { AgentCategory } from '@shared/schemas';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import * as configModule from '@utils/config/configUtils';

// Local file imports
import {
  GOOGLE_INTERACTIONS_TEST_CONFIG,
  StreamingGoogleInteractionsHandler,
  userStep,
} from './googleInteractionsTestUtils';

// Provider SDK types
import type { Interactions } from '@google/genai';

type Step = Interactions.Step;
type SSEEvent = Interactions.InteractionSSEEvent;

/** The capturing client surface the compaction test intercepts. */
interface InterceptableCreateClient {
  interactions: {
    create(params: unknown): Promise<unknown>;
  };
}

/** One recorded `interactions.create` request. */
interface RecordedCall {
  store: boolean | undefined;
  previousId: string | undefined;
  input: Step[];
}

/**
 * Capturing fake client. Each `interactions.create` records the request's
 * store / previous_interaction_id / input, then yields the SSE events produced
 * by the per-call `eventsFor(callIndex)` factory. A factory may throw to
 * simulate an SDK rejection BEFORE the stream is consumed.
 */
function capturingClient(
  calls: RecordedCall[],
  eventsFor: (callIndex: number) => SSEEvent[],
): unknown {
  let callIndex = 0;
  return {
    interactions: {
      create: async (params: {
        store?: boolean;
        previous_interaction_id?: string;
        input: Step[];
      }) => {
        const index = callIndex++;
        calls.push({
          store: params.store,
          previousId: params.previous_interaction_id,
          // Snapshot: the handler may reuse the live `messages` array reference
          // for a full resend, and the flow mutates it between rounds.
          input: [...params.input],
        });
        const events = eventsFor(index);
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
    models: {},
  };
}

/** Completed-interaction SSE tail with one text step and a given id/status. */
function completedEvents(
  id: string,
  status:
    'completed' | 'incomplete' | 'failed' | 'requires_action' = 'completed',
  text = 'ok',
): SSEEvent[] {
  return [
    {
      event_type: 'interaction.created',
      interaction: { id, status: 'in_progress' },
    },
    { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
    {
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'text', text },
    },
    { event_type: 'step.stop', index: 0 },
    {
      event_type: 'interaction.completed',
      interaction: { id, status },
    },
  ];
}

function createHandler(): ModelHandlerGoogleInteractions {
  const handler = new StreamingGoogleInteractionsHandler(
    buildTestModelConfig(GOOGLE_INTERACTIONS_TEST_CONFIG, {
      capabilities: {
        supportsReasoning: true,
        supportsTokenCounting: false,
      },
    }),
  );
  handler.setLogger({ ...noopTrace });
  handler.setOutputStreaming(true);
  return handler;
}

/** Shorthand for the `handler.createResponse({ client, messages, temperature: 0 })`
 * call every test in this file makes (the fake `client` never matches the SDK
 * client type, hence the `as never` cast). */
function respond(
  handler: ModelHandlerGoogleInteractions,
  client: unknown,
  messages: Step[],
) {
  return handler.createResponse({
    client: client as never,
    messages,
    temperature: 0,
  });
}

/** Extract the first text of a user_input/model_output step (for slice asserts). */
function stepText(step: Step): string | undefined {
  return (step as { content?: { text?: string }[] }).content?.[0]?.text;
}

/** Error the SDK raises for an expired previous_interaction_id. */
function staleChainError(): Error {
  return Object.assign(new Error('previous_interaction_id not found'), {
    status: 404,
  });
}

/**
 * Standard per-test rig: a handler, its recorded calls, the capturing client,
 * and a live transcript seeded with user steps. Tests mutate `messages`
 * between rounds to mimic the flow appending new steps.
 */
function setupChained(
  eventsFor: (callIndex: number) => SSEEvent[],
  initialUserTexts: readonly string[] = ['a'],
): {
  handler: ModelHandlerGoogleInteractions;
  calls: RecordedCall[];
  client: unknown;
  messages: Step[];
} {
  const handler = createHandler();
  const calls: RecordedCall[] = [];
  const client = capturingClient(calls, eventsFor);
  return { handler, calls, client, messages: initialUserTexts.map(userStep) };
}

const originalGetConfig = configModule.getConfig;

/** Force the server-state setting to a fixed value (default in code is true). */
function mockServerState(enabled: boolean): void {
  vi.spyOn(configModule, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T => {
      if (key === 'texra.model.useGoogleInteractionsServerState') {
        return enabled as T;
      }
      return originalGetConfig(key, defaultValue);
    },
  );
}

describe('ModelHandlerGoogleInteractions store:true chaining', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T1: first request is a full resend with store:true and no previous_interaction_id', async () => {
    const { handler, calls, client, messages } = setupChained(
      () => completedEvents('int_1'),
      ['a', 'b'],
    );

    await respond(handler, client, messages);

    expect(calls).toHaveLength(1);
    expect(calls[0].store).toBe(true);
    expect(calls[0].previousId).toBeUndefined();
    expect(calls[0].input).toHaveLength(messages.length);
  });

  it('T2/T3: continuation sends only the delta with previous_interaction_id, reusing the captured id', async () => {
    const { handler, calls, client, messages } = setupChained(
      (i) => completedEvents(i === 0 ? 'int_abc' : 'int_def'),
      ['a', 'b'],
    );

    // Round 1: two steps sent in full, id captured.
    await respond(handler, client, messages);

    // Round 2: the flow appends two new steps to the same array.
    messages.push(userStep('c'), userStep('d'));
    await respond(handler, client, messages);

    expect(calls).toHaveLength(2);
    // First call: full, no chain.
    expect(calls[0].input).toHaveLength(2);
    expect(calls[0].previousId).toBeUndefined();
    // Second call: delta only (exactly the 2 appended steps in order), chained
    // to round 1's id.
    expect(calls[1].store).toBe(true);
    expect(calls[1].previousId).toBe('int_abc');
    expect(calls[1].input).toHaveLength(2);
    expect(calls[1].input.map(stepText)).toEqual(['c', 'd']);
  });

  it('T2c: chained delta sends only client-input steps; server-held model steps are filtered out', async () => {
    // Verified live: echoing a server-held function_call on a chained tool round
    // returns HTTP 400; only the function_result must be sent.
    const { handler, calls, client, messages } = setupChained((i) =>
      completedEvents(i === 0 ? 'int_1' : 'int_2'),
    );

    await respond(handler, client, messages);

    // Mimic the flow appending the model-generated turn (server-held) + a tool
    // result + a new user turn before the next round.
    messages.push(
      {
        type: 'thought',
        signature: 'sig',
        summary: [{ type: 'text', text: 't' }],
      } as Step,
      { type: 'function_call', id: 'c1', name: 'tool', arguments: {} } as Step,
      {
        type: 'function_result',
        call_id: 'c1',
        name: 'tool',
        result: [{ type: 'text', text: 'r' }],
      } as Step,
      userStep('b'),
    );
    await respond(handler, client, messages);

    expect(calls[1].previousId).toBe('int_1');
    // thought + function_call (server-held) are dropped; only the result + new user remain.
    expect(calls[1].input.map((s) => s.type)).toEqual([
      'function_result',
      'user_input',
    ]);
  });

  it('T4: an incomplete response does not chain; next round is a full resend', async () => {
    const { handler, calls, client, messages } = setupChained((i) =>
      i === 0
        ? completedEvents('int_1', 'incomplete')
        : completedEvents('int_2', 'completed'),
    );

    await respond(handler, client, messages);

    messages.push(userStep('b'));
    await respond(handler, client, messages);

    // Second call full-resends both steps, no previous_interaction_id.
    expect(calls[1].previousId).toBeUndefined();
    expect(calls[1].input).toHaveLength(2);
  });

  it('T4b: a requires_action (tool-call) response chains, so the next round continues the interaction', async () => {
    // Tool-call rounds finish as `requires_action` (model emitted a function
    // call, awaiting results). The interaction is retained and continuable, so
    // the handler must chain onto it (mirrors OpenAI, whose tool responses are
    // `completed`). Without this, tool-using agents drop the chain every round.
    const { handler, calls, client, messages } = setupChained((i) =>
      completedEvents(i === 0 ? 'int_1' : 'int_2', 'requires_action'),
    );

    await respond(handler, client, messages);

    // The flow appends the model-generated steps; round 2 continues the chain.
    messages.push(userStep('b'));
    await respond(handler, client, messages);

    expect(calls[1].store).toBe(true);
    expect(calls[1].previousId).toBe('int_1'); // chained onto the tool round
  });

  it('T5: an expired previous_interaction_id triggers exactly one full-resend retry', async () => {
    const { handler, calls, client, messages } = setupChained((i) => {
      // Call 0: establish a chain. Call 1: chained request rejected as stale.
      // Call 2: the retry (full resend) succeeds.
      if (i === 1) throw staleChainError();
      return completedEvents(i === 0 ? 'int_1' : 'int_3');
    });

    await respond(handler, client, messages);

    messages.push(userStep('b'));
    const result = await respond(handler, client, messages);

    // 3 create calls total: initial + failed-chained + retried-full.
    expect(calls).toHaveLength(3);
    // The retry full-resends with no previous_interaction_id.
    expect(calls[2].previousId).toBeUndefined();
    expect(calls[2].input).toHaveLength(2);
    // The successful retry re-established a fresh chain.
    expect(result.response.id).toBe('int_3');
  });

  it('T5b: the stale-id retry is bounded — a second failure is not retried again', async () => {
    const { handler, calls, client, messages } = setupChained((i) => {
      // Call 0: establish a chain. Call 1: chained request rejected as stale.
      // Call 2 (the one full-resend retry): ALSO rejected — must NOT retry again.
      if (i >= 1) throw staleChainError();
      return completedEvents('int_1');
    });

    await respond(handler, client, messages);

    messages.push(userStep('b'));
    await expect(respond(handler, client, messages)).rejects.toThrow(
      /previous_interaction_id/,
    );

    // Exactly 3 create calls: initial + failed-chained + failed-retry (no 4th).
    // The retry sent a full resend (no previous_interaction_id), so it cannot
    // re-enter the stale-id branch — the error propagates to the caller.
    expect(calls).toHaveLength(3);
    expect(calls[2].previousId).toBeUndefined();
  });

  it('T6: compaction clears the chain and returns updatedMessages', async () => {
    const handler = createHandler();
    handler.setAgentCategory(AgentCategory.ToolUse);
    (
      handler as unknown as {
        postProcessResponse: (text: string) => string;
      }
    ).postProcessResponse = () => 'REWRITTEN';
    const calls: RecordedCall[] = [];
    const client = capturingClient(calls, (i) =>
      completedEvents(i === 0 ? 'int_1' : 'int_2'),
    ) as InterceptableCreateClient;
    // Compaction uses a separate stateless, non-streaming Interactions call.
    const create = client.interactions.create;
    client.interactions.create = async (params: { stream?: boolean }) => {
      if (params.stream === false) {
        return {
          id: 'compact',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'text', text: 'SUMMARY' }],
            },
          ],
          usage: { total_output_tokens: 5 },
        };
      }
      return create(params);
    };

    // Round 1 establishes a chain.
    const messages: Step[] = [userStep('a'), userStep('b'), userStep('c')];
    await respond(handler, client, messages);
    expect(calls[0].previousId).toBeUndefined();

    // Round 2: request manual compaction. The handler must clear the chain
    // (full resend, no previous_interaction_id) and return updatedMessages.
    handler.requestCompaction();
    messages.push(userStep('d'), userStep('e'));
    const result = await respond(handler, client, messages);

    expect(result.updatedMessages).toBeDefined();
    expect(result.updatedMessages!.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result.updatedMessages)).toContain('SUMMARY');
    expect(JSON.stringify(result.updatedMessages)).not.toContain('REWRITTEN');
    // The compacted round full-resent (no chain) the compacted transcript.
    expect(calls[1].previousId).toBeUndefined();
    expect(calls[1].input).toEqual(result.updatedMessages);

    // Round 3: the flow swaps in the compacted transcript (updatedMessages) and
    // appends a new turn. Chaining must RE-ESTABLISH off the compaction's id —
    // i.e. compaction must not permanently disable chaining.
    const compacted = result.updatedMessages!;
    const round3: Step[] = [...compacted, userStep('f')];
    await respond(handler, client, round3);
    expect(calls[2].store).toBe(true);
    expect(calls[2].previousId).toBe('int_2'); // chained onto the compaction response
    expect(calls[2].input).toHaveLength(1); // only the newly appended step
    expect(calls[2].input.map(stepText)).toEqual(['f']);
  });

  it('T7: with the setting OFF the handler stays stateless (store:false, full input, no chaining)', async () => {
    mockServerState(false);
    const { handler, calls, client, messages } = setupChained(() =>
      completedEvents('int_1'),
    );

    await respond(handler, client, messages);

    messages.push(userStep('b'));
    await respond(handler, client, messages);

    for (const call of calls) {
      expect(call.store).toBe(false);
      expect(call.previousId).toBeUndefined();
    }
    // Both calls resend the full transcript (no delta slicing).
    expect(calls[0].input).toHaveLength(1);
    expect(calls[1].input).toHaveLength(2);
  });

  it('T8: a fresh handler instance (resume) starts with a full resend', async () => {
    // First instance establishes a chain.
    const first = createHandler();
    const callsA: RecordedCall[] = [];
    await respond(
      first,
      capturingClient(callsA, () => completedEvents('int_1')),
      [userStep('a')],
    );
    expect(callsA[0].previousId).toBeUndefined();

    // A brand-new instance (simulating resume-from-snapshot) sees the same
    // transcript but has no chain id, so it full-resends with no chaining.
    const restored = createHandler();
    const callsB: RecordedCall[] = [];
    await respond(
      restored,
      capturingClient(callsB, () => completedEvents('int_2')),
      [userStep('a'), userStep('b')],
    );
    expect(callsB[0].previousId).toBeUndefined();
    expect(callsB[0].input).toHaveLength(2);
  });

  it('T9: the single-turn guard rejects a concurrent call and resets afterward', async () => {
    const handler = createHandler();
    const calls: RecordedCall[] = [];
    // A create that blocks until released, so we can overlap two calls.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client: unknown = {
      interactions: {
        create: async (params: { store?: boolean; input: Step[] }) => {
          calls.push({
            store: params.store,
            previousId: undefined,
            input: params.input,
          });
          await gate;
          return (async function* () {
            for (const event of completedEvents('int_1')) yield event;
          })();
        },
      },
      models: {},
    };

    const inFlight = respond(handler, client, [userStep('a')]);

    await expect(respond(handler, client, [userStep('b')])).rejects.toThrow(
      /single-turn/,
    );

    release();
    await inFlight;

    // The guard reset in finally: a serial call now succeeds.
    await expect(
      respond(
        handler,
        capturingClient([], () => completedEvents('int_2')),
        [userStep('c')],
      ),
    ).resolves.toBeDefined();
  });
});
