# @texra-ai/llm

TeXRA's complete model package: the model catalog over `llm-zoo`, the
provider catalog, the route decision, the subscription sign-in flows, and one
contract over four HTTP wire protocols and the editor's `vscode-lm`. A
`Model` is a configured executable value. It owns the wire — lowering a turn,
decoding the stream, classifying the failure — and nothing else. Conversation,
retry, pricing, approval, budgets and persistence are the runtime's, and the
package is pure: no `platform()`, no `Effect.run*`, no `AbortController`, no
`vscode`. It reads no settings and imports nothing else in the repo: the host
passes configuration in (`RouteFacts`) and credentials through one port,
`CredentialStore`. Its only dependencies are `llm-zoo`, the provider SDKs,
`ws`, and `effect` and `zod` as peers.

> **0.x: the API may change in any minor release.** The package is versioned
> on its own, not with the TeXRA app.

## Install

Requires Node.js 22.19.0 or later in 22.x, or Node.js 24 or later. The
package is ESM only. `effect` and `zod` (v4) are peer dependencies, so your
install supplies the one copy of each:

```bash
npm install @texra-ai/llm effect zod
```

## Example

Pick a catalog model, decide its route, bind it, and run one turn. The key is
read from the environment here; the runnable version of this program,
[`packages/harness/example/llm.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/llm.ts), passes a `fetch`
that answers 401 instead so it needs no key.

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

const selected = selectModel('anthropic/claude-sonnet-5');
if (selected === undefined) throw new Error('Unknown model.');
const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);
const endpoint = resolveRouteEndpoint(selected.config, route, {
  endpoints: {},
});
if (endpoint === undefined) throw new Error('No endpoint for the provider.');

const program = Effect.gen(function* () {
  const { model } = yield* bindModel({
    protocol: 'anthropic-messages',
    model: selected.config,
    endpoint,
    credentialScope: 'anthropic:api-key',
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
  const turn = yield* model.prepareTurn({
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello.' }] }],
  });
  if (turn.mode !== 'foreground')
    throw new Error('Expected a foreground turn.');
  return yield* completedTurn(model.streamTurn(turn));
}).pipe(Effect.scoped);

console.log(await Effect.runPromise(program));
```

Every failure is a `ModelError` whose `kind` classifies it (`authentication`,
`rate-limited`, …). The package retries nothing: retry, pricing and persistence
belong to the caller ([`@texra-ai/harness`](../harness/README.md) is one).

## The entries

The package is split by where its code runs, not by topic.

| Entry    | What it holds                                                                                                                                                                                                     | Runs in      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `.`      | the turn contract (`turn.ts`), the provider catalog and key lookup (`providers/`), the route decision, `routeConfig`, the route endpoint, the reasoning choice (`models/`), `CredentialStore`, the account labels | browser-safe |
| `./node` | `bindModel(configuration, credential, transport) → Model`, the ChatGPT and Grok sign-in flows and their coordinators (`oauth/`), `SharedAttempt`                                                                  | Node         |

The protocols (`api/`), the prefix fingerprint and the upload cache are
internal: `bindModel` loads the chosen protocol with a literal
`import('./api/<protocol>.js')`, so a run loads only its provider's SDK.
ESLint holds the rest: nothing under `src/` imports another repo module, and
outside `api/`, `oauth/` and `node.ts` nothing imports a Node built-in or a
vendor SDK.

Inside the workspace the entries are the TypeScript sources. `npm run build`
writes what a pack publishes (`publishConfig.exports`): one ESM bundle per
entry under `dist/`, each protocol a chunk, OpenAI's patched runtime carried
inside, and the entries' declarations, checked by the harness's artifact
validator.

## The contract

`src/turn.ts` defines it. Every operation returns an `Effect` or a `Stream`
and fails only with `ModelError`.

```ts
prepareTurn(request) -> ResolvedTurn // freeze the binding and the controls
streamTurn(turn)     -> Stream<TurnEvent>
```

A caller that wants only the result folds the stream with
`completedTurn(model.streamTurn(turn))`; there is no separate non-streaming
member, so the two paths cannot diverge. Preparation is where a
request is admitted or rejected: an unsupported control, an unrepresentable
history or an unsupported media part fails there, before transport. Execution
never rewrites an admitted request.

Three optional members, present only where the binding serves them:
`uploadFile` / `releaseUploads` (provider file ids, held in the model's memory
only and never persisted) and `background` (`submit`, `observe`, `cancel`) for
the protocols with remote execution. `observe` takes the admitted turn back
because a completion's continuation anchors to the exact history prefix it
covers, which the operation handle deliberately does not copy.

## The tree

| File                              | What it owns                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `turn.ts`                         | the `.` entry's turn contract: the `Model` interface, the request, configuration, result and event contract, the tool and reasoning schemas, `completedTurn` |
| `protocol.ts`                     | the protocol enum, binding identity (`BindingSchema`, `OriginSchema`, `ModelOriginSchema`) and JSON materialization                                          |
| `message.ts`                      | the wire message and history schemas, the content parts, and the continuation prefixes                                                                       |
| `errors.ts`                       | `ModelError` and the failure classification along it, `RemoteOperation` included                                                                             |
| `api/transport.ts`                | stream pull, tool-argument parsing, the abort-safe request helper                                                                                            |
| `api/openaiResponses.ts`          | `openaiResponsesModel`                                                                                                                                       |
| `api/parts.ts`                    | the part events every codec reports a response in, and the canonical-part algebra (identity, restatement, growth)                                            |
| `api/assembleTurn.ts`             | the one turn fold over part events: identity, positions, deltas, call arguments, finish agreement, terminal validation                                       |
| `api/openaiResponsesCodec.ts`     | the response-side schemas, content lowering, and the one Responses event decoder (stream, WebSocket, observation)                                            |
| `api/openaiResponsesUsage.ts`     | the usage receipt schema and its normalization, xAI's settled cost included                                                                                  |
| `api/openaiResponsesLower.ts`     | input lowering and the continuation anchor                                                                                                                   |
| `api/openaiResponsesRequest.ts`   | preparing a turn, its parameters, the abort classification                                                                                                   |
| `api/openaiResponsesWebSocket.ts` | the experimental WebSocket transport                                                                                                                         |
| `api/anthropicMessages.ts`        | `anthropicMessagesModel`                                                                                                                                     |
| `api/googleInteractions.ts`       | `googleInteractionsModel`                                                                                                                                    |
| `api/openrouterChat.ts`           | `openrouterChatModel`                                                                                                                                        |
| `api/uploadCache.ts`              | the digest-keyed, model-scoped upload cache behind `uploadFile`                                                                                              |
| `api/prefixFingerprint.ts`        | the admitted-history fingerprint a background completion anchors on                                                                                          |
| `api/openaiError.ts`              | SDK error classification into `ModelError`                                                                                                                   |
| `node.ts`                         | the `./node` entry: `bindModel`, the protocol choice, and the sign-in exports                                                                                |
| `providers/`                      | the provider plugins, the API-key providers and `CredentialStore`, the coding plans                                                                          |
| `models/`                         | model selection over llm-zoo, the route decision and its config and endpoint, OpenRouter routing, the reasoning choice, the picker's base option             |
| `oauth/`                          | the ChatGPT (`codex/`) and Grok (`xai/`) sign-in flows over the shared OAuth coordinator, loopback and device flows                                          |

The `vscode-lm` protocol cannot live here: it is acquired from the
editor. `packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts`
implements the same `Model` contract against `vscode.lm`, captures one
concrete model with its exact vendor, id and version, and rejects a foreign or
retired acquisition rather than silently selecting a replacement.

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

- Hosted tools, ruled out of 1.0
  ([the ruling](../../.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md)):
  the run's local `web_search` and `web_fetch` tools are the one system for
  web search and fetch, and the codecs request no provider-hosted tool. A
  stream that carries hosted execution still fails explicitly — the hosted
  blocks fail the event schema as malformed output, and a paused hosted turn
  fails by name as the boundary a future lane would have to implement.
- Assistant media output, Responses service-tier billing accounting, native
  provider compaction, and OpenRouter continuation.
- Streaming reconnection and managed-agent execution for background work.
  Observation polls or re-reads; it never creates a replacement generation.
- Remote cancellation is only ever claimed when the provider answers
  `cancelled`. Interrupting the local request is not an acknowledgement, and
  an interrupted submission can leave remote work whose receipt was never
  delivered: the runtime must not infer that no work happened.

## What the tests prove, and what they do not

Two tiers, deliberately separate.

`src/test-kernel/llm/` is about 9 700 lines of synthetic-transport suites: they
pin lowering, decoding, ordering and every explicit failure, against fixtures.
They stay hermetic and free, so no suite in them calls a provider, and they run
in `npm test`.

`test-live/` is the wire evidence: one key-gated suite per HTTP provider route,
behind `vitest.live.config.mjs`. Each suite skips itself unless its own key is
in the environment, so a run with one key exercises one route and skips the
rest. It is deliberately not part of `npm test`: reach it by name
(`npm run test:live`) or through the labelled job in
`.github/workflows/live-llm.yml`. `vscode-lm` has no
suite there — it is acquired through the extension host's `vscode.lm` API, so
its live check belongs to an Extension Development Host job.

What the live tier does not claim: SSE parsing belongs to the vendor SDKs, so
the package makes no bounded-stream-memory claim, and cleanup joins foreign
finalizers, so it makes no bounded-stop-latency claim either.

## Background

[The package study](../../.agents/docs/implemented/architecture/2026-09-06-llm-package-architecture-study.md)
and
[the joint runtime contract](../../.agents/docs/implemented/architecture/2026-09-06-llm-runtime-contract.md)
are the design this package implements.
