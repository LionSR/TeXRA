/**
 * Example 01 — Direct model turns with `@texra-ai/llm`.
 *
 * Uses `@texra-ai/llm` and `@texra-ai/llm/node` standalone:
 * 1. Selects a catalog model (`selectModel`), decides its route (`decideModelRoute`),
 *    and resolves its endpoint (`resolveRouteEndpoint`).
 * 2. Binds `anthropic-messages` against an in-process SSE `fetch`, prepares a
 *    turn (`prepareTurn`), streams `TurnEvent`s (`streamTurn`), and computes the
 *    turn's USD cost (`turnCost`).
 * 3. Binds against a 401 `fetch` to show how transport failures classify into
 *    a single typed `ModelError` (`kind`, `retryable`, `scope`, `status`).
 */
import { Effect, Stream } from 'effect';
import {
  chooseReasoning,
  completedTurn,
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
  resolveRouteEndpoint,
  selectModel,
  turnCost,
} from '@texra-ai/llm';
import { bindModel } from '@texra-ai/llm/node';

const selected = selectModel('anthropic/claude-sonnet-5');
if (selected === undefined) throw new Error('The catalog lost the model.');
const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);
const endpoint = resolveRouteEndpoint(selected.config, route, {
  endpoints: {},
});
if (endpoint === undefined) throw new Error('No endpoint for the provider.');
console.log(
  `[01] model: ${selected.config.label}, ${route.provider} at ${endpoint}`,
);

const sseEvents = [
  {
    type: 'message_start',
    message: {
      id: 'msg_example_01',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-5',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Theorem 1 holds.' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
];
const sseBody = sseEvents
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join('');

const mockSseFetch: typeof fetch = async () =>
  new Response(sseBody, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const unauthorizedFetch: typeof fetch = async () =>
  Response.json(
    {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    },
    { status: 401 },
  );

const baseOptions = {
  maxOutputTokens: 1024,
  temperature: 0,
  reasoning: chooseReasoning(selected.config, selected.request),
  parallelToolCalls: false,
  reasoningSummary: false,
  serverState: false,
  fastTier: false,
  webSocket: false,
  background: false,
} as const;

const program = Effect.gen(function* () {
  // 1. Streamed turn over synthetic SSE
  const okBinding = yield* bindModel({
    protocol: 'anthropic-messages',
    model: selected.config,
    endpoint,
    credentialScope: `${route.provider}:api-key`,
    credential: { kind: 'api-key', apiKey: 'test-key' },
    billing: 'api-key',
    options: { ...baseOptions, fetch: mockSseFetch },
  });
  console.log('[01] bound:', okBinding.origin.protocol);

  const prepared = yield* okBinding.model.prepareTurn({
    system: 'Reply in one short sentence.',
    messages: [
      { role: 'user', content: [{ kind: 'text', text: 'State Theorem 1.' }] },
    ],
  });
  if (prepared.mode !== 'foreground') {
    throw new Error('Expected a foreground turn.');
  }

  const deltas: string[] = [];
  const completed = yield* okBinding.model.streamTurn(prepared).pipe(
    Stream.tap((event) =>
      Effect.sync(() => {
        if (event.kind === 'delta' && event.part === 'text') {
          deltas.push(event.text);
        }
      }),
    ),
    completedTurn,
  );
  const cost = completed.usage
    ? turnCost(selected.config, completed.usage, { plan: false })
    : null;
  console.log(
    `[01] streamed: "${deltas.join('')}" (finish=${completed.finishReason}, tokens=${completed.usage?.totalTokens ?? 0}, cost=$${cost?.toFixed(6) ?? '0'})`,
  );

  // 2. Typed ModelError classification on HTTP 401
  const badBinding = yield* bindModel({
    protocol: 'anthropic-messages',
    model: selected.config,
    endpoint,
    credentialScope: `${route.provider}:api-key`,
    credential: { kind: 'api-key', apiKey: 'not-a-real-key' },
    billing: 'api-key',
    options: { ...baseOptions, fetch: unauthorizedFetch },
  });
  const badTurn = yield* badBinding.model.prepareTurn({
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello.' }] }],
  });
  if (badTurn.mode !== 'foreground') {
    throw new Error('Expected a foreground turn.');
  }
  const failure = yield* Effect.flip(
    completedTurn(badBinding.model.streamTurn(badTurn)),
  );
  console.log(
    `[01] turn failed: ModelError kind=${failure.kind} status=${failure.status} retryable=${failure.retryable} scope=${failure.scope}`,
  );
}).pipe(Effect.scoped);

await Effect.runPromise(program);
