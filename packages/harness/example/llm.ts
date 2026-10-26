/**
 * `@texra-ai/llm` on its own, as a consumer off the registry would use it:
 * pick a catalog model, decide its route, bind it, and run one turn. It
 * needs no provider key: the binding's `fetch` answers every request with
 * the 401 a wrong key gets, so the turn fails with the typed `ModelError`
 * the package classifies it as, and nothing leaves the process.
 */
import { Effect } from 'effect';
import {
  chooseReasoning,
  completedTurn,
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
  resolveRouteEndpoint,
  selectModel,
} from '@texra-ai/llm';
import { bindModel } from '@texra-ai/llm/node';

const selected = selectModel('anthropic/claude-sonnet-5-5');
if (selected === undefined) throw new Error('The catalog lost the model.');
const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);
const endpoint = resolveRouteEndpoint(selected.config, route, {
  endpoints: {},
});
if (endpoint === undefined) throw new Error('No endpoint for the provider.');
console.log(
  `model: ${selected.config.label}, ${route.provider} at ${endpoint}`,
);

const unauthorized: typeof fetch = async () =>
  Response.json(
    {
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    },
    { status: 401 },
  );

const program = Effect.gen(function* () {
  const binding = yield* bindModel({
    protocol: 'anthropic-messages',
    model: selected.config,
    endpoint,
    credentialScope: `${route.provider}:api-key`,
    credential: { kind: 'api-key', apiKey: 'not-a-real-key' },
    billing: 'api-key',
    options: {
      maxOutputTokens: 1024,
      temperature: 0,
      reasoning: chooseReasoning(selected.config, selected.request),
      parallelToolCalls: false,
      reasoningSummary: false,
      serverState: false,
      fastTier: false,
      webSocket: false,
      background: false,
      fetch: unauthorized,
    },
  });
  console.log('bound:', binding.origin.protocol);
  const turn = yield* binding.model.prepareTurn({
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello.' }] }],
  });
  if (turn.mode !== 'foreground')
    throw new Error('Expected a foreground turn.');
  const failure = yield* Effect.flip(
    completedTurn(binding.model.streamTurn(turn)),
  );
  console.log(`turn failed: ModelError ${failure.kind}`);
}).pipe(Effect.scoped);

await Effect.runPromise(program);
