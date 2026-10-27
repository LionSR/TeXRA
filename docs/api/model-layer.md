# Model Layer (`@texra-ai/llm`)

[`@texra-ai/llm`](./llm/) owns the model catalog (over `llm-zoo`), the provider catalog, route and endpoint decisions, OAuth subscription sign-in flows, and a single [`Model`](./llm/#model) turn contract over three HTTP wire protocols (`anthropic-messages`, `openai-responses`, and `google-interactions`).

## Scope and boundaries

- **Zero repo dependencies and zero ambient state.** `@texra-ai/llm` imports nothing from `@texra-ai/harness`, reads no settings stores, calls no `Effect.run*`, and creates no `AbortController`s outside Effect fiber interruption. Configuration arrives as values ([`RouteFacts`](./llm/#routefacts), [`BindSpec`](./llm/node#bindspec)), and credentials arrive through [`CredentialStore`](./llm/#credentialstore).
- **One turn in, one stream out.** A `Model` prepares and streams a single turn (`prepareTurn` $\to$ `streamTurn`). Conversation state, tool execution, retry gates, durable permits, and persistence belong to [`@texra-ai/harness`](./harness/).
- **No internal retries.** Vendor SDK retries are disabled. Every failure is classified into [`ModelError`](./llm/#modelerror) (`kind`, `retryable`, `scope`, `retryAfterMs`, `quota`, `status`) so the caller controls retry policy.
- **Explicit failure on unsupported input.** Unsupported controls, media parts, or provider-hosted tool blocks fail in `prepareTurn` or stream decoding with `ModelError` rather than being silently dropped.

## Entries

| Entry                                  | Environment  | Exports                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[`@texra-ai/llm`](./llm/)**          | Browser-safe | `Model`, `TurnRequest`, `ResolvedTurn`, `TurnEvent`, `TurnResult`, `completedTurn`, `ModelError`, `selectModel`, `MODEL_PROVIDER_PLUGINS`, `decideModelRoute`, `resolveRouteEndpoint`, `chooseReasoning`, `turnCost`, `CredentialStore` |
| **[`@texra-ai/llm/node`](./llm/node)** | Node.js      | `bindModel(spec)`, `BindSpec`, `Binding`, `ModelCredential`, ChatGPT (`codex`) and Grok (`xai`) OAuth sign-in flows and `SubscriptionCoordinator`s, `SharedAttempt`                                                                     |

`bindModel` loads its protocol module on demand (`import('./api/<protocol>.js')`), so a process only loads the SDK of the provider it binds, and the published `.d.ts` files never expose vendor SDK types.

## Running a turn (`01-llm-turn.ts`)

From [`packages/harness/example/01-llm-turn.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/01-llm-turn.ts):

```ts
import { Effect } from 'effect';
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
if (!selected) throw new Error('Unknown model.');

const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);

const endpoint = resolveRouteEndpoint(selected.config, route, {
  endpoints: {},
});
if (!endpoint) throw new Error('No endpoint for the provider.');

const program = Effect.gen(function* () {
  const binding = yield* bindModel({
    protocol: 'anthropic-messages',
    model: selected.config,
    endpoint,
    credentialScope: `${route.provider}:api-key`,
    credential: {
      kind: 'api-key',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    },
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
    },
  });

  const turn = yield* binding.model.prepareTurn({
    system: 'Reply in one short sentence.',
    messages: [
      { role: 'user', content: [{ kind: 'text', text: 'State Theorem 1.' }] },
    ],
  });
  if (turn.mode !== 'foreground') {
    throw new Error('Expected a foreground turn.');
  }

  const result = yield* completedTurn(binding.model.streamTurn(turn));
  const cost = result.usage
    ? turnCost(selected.config, result.usage, { plan: false })
    : null;
  return { result, cost };
}).pipe(Effect.scoped);
```

### Contract details

- **`prepareTurn(request) -> ResolvedTurn`**: freezes the binding and validates `request` (messages, tool definitions, tool choice, reasoning controls, and media parts) before network I/O.
- **`streamTurn(turn) -> Stream<TurnEvent, ModelError>`**: streams part deltas and a terminal `completed` event assembled by a single turn reducer across all protocols. Callers that want only the final [`TurnResult`](./llm/#turnresult) reduce the stream with [`completedTurn`](./llm/#completedturn).
- **Optional members on `Model`**:
  - `uploadFile` / `releaseUploads`: digest-keyed, model-scoped provider file upload cache, released when the binding's `Scope` closes.
  - `background` (`submit`, `observe`, `cancel`): remote execution for protocols that support detached turns (`openai-responses`, `google-interactions`). `cancel` claims cancellation only when the provider replies `cancelled`.

## `ModelError` fields

Every failure from `bindModel`, `prepareTurn`, or `streamTurn` is a [`ModelError`](./llm/#modelerror) (`_tag: 'ModelError'`):

| Field                                        | Meaning                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                       | `'invalid-request'` · `'unsupported'` · `'authentication'` · `'rate-limited'` · `'quota-exhausted'` · `'context-overflow'` · `'continuation-gone'` · `'transport'` · `'provider-rejection'` · `'malformed-output'` · `'observation-deadline'` |
| `retryable`                                  | Whether repeating the request unchanged can succeed (derived from `kind`, `status`, and vendor reply metadata).                                                                                                                               |
| `scope`                                      | `'model'` (limit on this model) or `'route'` (provider, credential, or endpoint).                                                                                                                                                             |
| `retryAfterMs`                               | Provider-reported retry delay in milliseconds, when present.                                                                                                                                                                                  |
| `quota`                                      | For `'quota-exhausted'`: the exhausted `plan` (`PlanRoute` or `null` for account credit) and reset timestamp.                                                                                                                                 |
| `status`, `requestId`, `responseId`, `model` | HTTP status and provider trace identifiers when a reply was received.                                                                                                                                                                         |

[`ModelErrorFields`](./llm/#modelerrorfields) types these fields as plain data for persistence and IPC.
