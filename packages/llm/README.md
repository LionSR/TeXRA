# @texra-ai/llm

TeXRA's model package: the model catalog over `llm-zoo`, the provider catalog,
the route decision, the subscription sign-in flows, and one contract over three
HTTP wire protocols. A `Model` is a configured executable value that lowers a
turn, decodes the stream, and classifies failures. Conversation state, retries,
pricing, approvals, budgets, and persistence belong to the caller, and the
package is pure: the host passes configuration in (`RouteFacts`) and
credentials through `CredentialStore`.

> **0.x: the API may change in any minor release.** The package is versioned
> on its own, not with the TeXRA app.

## Install

Requires Node.js 22.19.0 or later in 22.x, or Node.js 24 or later. The
package is ESM only. `effect` (^4.0.6) is a peer dependency, so your install
supplies the one copy of it:

```bash
npm install @texra-ai/llm effect
```

`llm-zoo` (the catalog) and the Anthropic and Google SDKs come in as
dependencies. A binding loads only its own protocol's SDK, on demand.
OpenAI's runtime is bundled, so `openai` is not installed.

## Example

Pick a catalog model, decide its route, bind it, and run one turn. Here the
key is read from the environment. The runnable version of this program,
[`packages/harness/example/llm.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/llm.ts),
passes a `fetch` that answers 401, so it needs no key.

```ts
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
if (selected === undefined) throw new Error('Unknown model.');
const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);
const endpoint = resolveRouteEndpoint(selected.config, route, {
  endpoints: {},
});
if (endpoint === undefined) throw new Error('No endpoint for the provider.');

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
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello.' }] }],
  });
  if (turn.mode !== 'foreground')
    throw new Error('Expected a foreground turn.');
  return yield* completedTurn(binding.model.streamTurn(turn));
}).pipe(
  Effect.scoped,
  Effect.catchTag('ModelError', (error) =>
    Effect.fail(new Error(`${error.kind}: ${error.message}`)),
  ),
);

const result = await Effect.runPromise(program);
console.log(result.content);
```

`bindModel` returns a `Binding`. It holds the `Model` and the facts its
configuration fixed: the origin, background capability, service tier, and
whether the route takes a forced tool choice. The connection, and any files
the model uploads, live in the caller's `Scope`. Closing the scope releases
them.

## Errors

A `Model` fails with exactly one error type, `ModelError` (`_tag:
'ModelError'`). Fiber interruption stays outside it. Branch on its fields,
never on its message:

| Field                                        | What it says                                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                       | the class of failure: `invalid-request`, `unsupported`, `authentication`, `rate-limited`, `quota-exhausted`, `context-overflow`, `continuation-gone`, `transport`, `provider-rejection`, `malformed-output`, `observation-deadline` |
| `retryable`                                  | whether repeating the request unchanged can succeed. It defaults from `kind` and `status`; the binding overrides it where the vendor's reply says more                                                                              |
| `scope`                                      | what the failure is evidence about beyond this request: `model` (a limit on one model) or `route` (the provider, credential and endpoint)                                                                                           |
| `retryAfterMs`                               | the provider's own "come back in" delay, when its reply stated one                                                                                                                                                                  |
| `quota`                                      | for `quota-exhausted`: the `plan` used up (a `PlanRoute`, or `null` for the account's credit), and when it resets                                                                                                                   |
| `status`, `requestId`, `responseId`, `model` | the HTTP facts, when the failure had a reply                                                                                                                                                                                        |

The package itself retries nothing. Retry,
pricing and persistence belong to the caller
([`@texra-ai/harness`](../harness/README.md) is one).

The other failures are tagged errors too:

- `SecretsFailed` from a `CredentialStore`, and from a sign-in flow that
  reads or writes the session. Its `reason` is `store-unavailable` or `io`.
- `ReasoningChoiceError` from a strict `chooseReasoning`.
- From `./node`: `SubscriptionOAuthError`, whose `kind` is `fatal`,
  `expired`, `transient` or `config` and whose `needsReauth` says whether to
  sign in again. Also `LoopbackTransportUnavailableError`, raised when the
  browser sign-in cannot start, so the device-code flow can take over. The
  sign-in programs fail with a plain `Error` whose `message` is the text to
  show the user.

## The entries

The package is split by where its code runs, not by topic.

| Entry    | What it holds                                                                                                                                                                                                                                         | Runs in      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `.`      | the turn contract (`Model`, the request, result and event schemas, `completedTurn`), `ModelError`, the provider catalog and API-key lookup over `CredentialStore`, model selection, the route decision and endpoint, the reasoning choice, `turnCost` | browser-safe |
| `./node` | `bindModel(spec) → Binding`, the ChatGPT and Grok sign-in flows and their `SubscriptionCoordinator`s, `SharedAttempt`                                                                                                                                 | Node         |

Every type a public signature names is exported from one of the two entries.
Each entry's exports, with their TSDoc and declarations, are listed in
[`docs/api/index.md`](./docs/api/index.md) and
[`docs/api/node.md`](./docs/api/node.md), generated from the source.
The protocols (`api/`), the prefix fingerprint and the upload cache are
internal: `bindModel` loads the chosen protocol with a literal
`import('./api/<protocol>.js')`, so a run loads only its provider's SDK.
ESLint holds the rest: nothing under `src/` imports another repo module, and
outside `api/`, `oauth/` and `node.ts` nothing imports a Node built-in or a
vendor SDK.

Inside the workspace the entries are the TypeScript sources. `npm run build`
writes what a pack publishes (`publishConfig.exports`): one ESM bundle per
entry under `dist/`, each protocol a chunk, OpenAI's patched runtime carried
inside, and the entries' declarations with their TSDoc. The harness's
artifact validator checks the result, including that no published signature
names a type the entries do not export
(`packages/harness/scripts/forgotten-exports.mjs`).

## The contract

`src/turn.ts` defines it. Every operation returns an `Effect` or a `Stream`
and fails only with `ModelError`.

```text
prepareTurn(request) -> ResolvedTurn // freeze the binding and the controls
streamTurn(turn)     -> Stream<TurnEvent>
```

A caller that wants only the result collects the stream with
`completedTurn(model.streamTurn(turn))`; there is no separate non-streaming
member, so the two paths cannot diverge. Preparation is where a
request is accepted or rejected: an unsupported control, an unrepresentable
history or an unsupported media part fails there, before transport. Execution
never rewrites an accepted request.

Three optional members, present only where the binding serves them:
`uploadFile` / `releaseUploads` (provider file ids, held in the model's memory
only and never persisted) and `background` (`submit`, `observe`, `cancel`) for
the protocols with remote execution. `observe` takes the accepted turn back
because a completion's continuation anchors to the exact history prefix it
covers, which the operation handle deliberately does not copy.

## The tree

| File                              | What it owns                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.ts`                         | the `.` entry's turn contract: the `Model` interface, the request, configuration, result and event contract, the tool and reasoning schemas, `completedTurn`            |
| `protocol.ts`                     | the protocol enum, binding identity (`BindingSchema`, `ModelOriginSchema`) and JSON materialization                                                                     |
| `message.ts`                      | the wire message and history schemas, the content parts, and the continuation prefixes                                                                                  |
| `errors.ts`                       | `ModelError` and the failure classification along it, `RemoteOperation` included                                                                                        |
| `api/transport.ts`                | stream pull, tool-argument parsing, the abort-safe request helper                                                                                                       |
| `api/openaiResponses.ts`          | `openaiResponsesModel`                                                                                                                                                  |
| `api/parts.ts`                    | the part events every codec reports a response in, and the canonical-part algebra (identity, restatement, growth)                                                       |
| `api/assembleTurn.ts`             | the one turn reducer over part events: identity, positions, deltas, call arguments, finish agreement, terminal validation                                               |
| `api/openaiResponsesCodec.ts`     | the response-side schemas, content lowering, and the one Responses event decoder (stream, WebSocket, observation)                                                       |
| `api/openaiResponsesUsage.ts`     | the usage receipt schema and its normalization, xAI's final cost included                                                                                               |
| `api/openaiResponsesLower.ts`     | input lowering and the continuation anchor                                                                                                                              |
| `api/openaiResponsesRequest.ts`   | preparing a turn, its parameters, the abort classification                                                                                                              |
| `api/openaiResponsesWebSocket.ts` | the experimental WebSocket transport                                                                                                                                    |
| `api/anthropicMessages.ts`        | `anthropicMessagesModel`                                                                                                                                                |
| `api/googleInteractions.ts`       | `googleInteractionsModel`                                                                                                                                               |
| `api/uploadCache.ts`              | the digest-keyed, model-scoped upload cache behind `uploadFile`                                                                                                         |
| `api/prefixFingerprint.ts`        | the accepted-history fingerprint a background completion anchors on                                                                                                     |
| `api/openaiError.ts`              | SDK error classification into `ModelError`                                                                                                                              |
| `node.ts`                         | the `./node` entry: `bindModel`, the protocol choice, and the sign-in exports                                                                                           |
| `api/configuration.ts`            | the vendor rules that turn a catalog model, its route and the caller's options into each protocol's configuration (`responsesConfiguration.ts`: the Responses vendors') |
| `api/verdict.ts`                  | the verdict on a failure, read off the vendor's reply (`failureReply.ts`): status, retryability, scope, quota                                                           |
| `providers/`                      | the provider plugins, the API-key providers and their key lookup, `CredentialStore`                                                                                     |
| `models/`                         | model selection over llm-zoo, the route decision and its config and endpoint, the reasoning choice, a turn's cost                                                       |
| `oauth/`                          | the ChatGPT (`codex/`) and Grok (`xai/`) sign-in flows over the shared subscription coordinator, loopback and device flows                                              |

## Who calls it

`packages/harness/src/agent/runtime/modelAccess/ModelAccess.ts` binds a route to a `Model`, and
`packages/harness/src/agent/runtime/ModelInvoker.ts` is the one service that calls it — every
route, helper, tool-use turn and workflow round included. Retry has two owners
inside `ModelInvoker` (an automatic route-scoped batch under the session's
`ModelRetryGate`, and a durable human permit); none of it is in this package.

Every consumer imports `@texra-ai/llm` or `@texra-ai/llm/node`, so
`package.json`'s `exports` map is the boundary the resolver enforces: a module
this package does not export cannot be reached from outside it. Tests are the
one exception: the protocol suites in `src/test-kernel/llm/` reach `src/api/`
and the sign-in suites in `src/test-kernel/auth/` reach `src/oauth/` by
relative path, as `test-live/` does. Inside the package a module imports the file that defines a
symbol, in one acyclic direction — `protocol` ← `message` ← `errors` ←
`api/transport` ← `turn`, with each protocol's own modules below its entry —
and the only files that re-export are the two entries, whose published names
are contract.

## What it deliberately does not do

Unsupported content fails explicitly; no protocol silently discards reasoning,
media or evidence it cannot represent. The current explicit failures:

- Hosted tools: the run's local `web_search` and `web_fetch` tools are the one
  system for web search and fetch, and the codecs request no provider-hosted
  tool. A stream that carries hosted execution still fails explicitly — the
  hosted blocks fail the event schema as malformed output, and a paused hosted
  turn fails by name.
- Assistant media output, Responses service-tier billing accounting, and native
  provider compaction.
- Streaming reconnection and managed-agent execution for background work.
  Observation polls or re-reads; it never creates a replacement generation.
- Remote cancellation is only ever claimed when the provider answers
  `cancelled`. Interrupting the local request is not an acknowledgement, and
  an interrupted submission can leave remote work whose receipt was never
  delivered: the runtime must not infer that no work happened.

## What the tests prove, and what they do not

Two tiers, deliberately separate.

`src/test-kernel/llm/` is three synthetic-transport suites, one per protocol
family, about 1 500 lines and eight cases: they pin lowering, decoding, ordering
and the explicit failures they name, against fixtures. They stay hermetic and free, so no suite in them calls a provider, and they run
in `npm test`.

`test-live/` is the wire evidence: one key-gated suite per HTTP provider route,
behind `vitest.live.config.mjs`. Each suite skips itself unless its own key is
in the environment, so a run with one key exercises one route and skips the
rest. It is deliberately not part of `npm test`: reach it by name
(`npm run test:live`) or through the labelled job in
`.github/workflows/live-llm.yml`.

What the live tier does not claim: SSE parsing belongs to the vendor SDKs, so
the package makes no bounded-stream-memory claim, and cleanup joins foreign
finalizers, so it makes no bounded-stop-latency claim either.
