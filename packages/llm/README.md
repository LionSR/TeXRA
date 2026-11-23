<div align="center">

# `@texra-ai/llm`

**One pure Effect contract over OpenAI Responses, Anthropic Messages, and Google
Interactions.**<br />
Model catalog, routing, streaming, typed errors, and subscription sign-in for 10
providers and 140+ models, from [TeXRA](https://texra.ai).

[![npm](https://img.shields.io/badge/npm-%40texra--ai%2Fllm_0.1.0-6F387A?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/llm)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Catalog: llm-zoo](https://img.shields.io/badge/Catalog-llm--zoo-6F387A?style=flat)](https://github.com/texra-ai/llm-zoo)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-270939?style=flat)](https://github.com/LionSR/TeXRA/blob/main/LICENSE)

[Example](#example) · [Errors](#errors) · [Entries](#the-entries) · [Turn Contract](#the-contract) · [Testing](#what-the-tests-prove-and-what-they-do-not) · [API Reference](./docs/api/index.md)

</div>

---

TeXRA's model layer: the model catalog over `llm-zoo`, the provider catalog,
route selection, subscription sign-in flows, and one `Model` contract over three
HTTP/WebSocket wire protocols. A `Model` is a configured executable value that
lowers a turn, decodes the stream, and classifies failures. Conversation state,
retries, pricing policy, approvals, budgets, and persistence stay with the
caller. The package is pure: hosts pass configuration in (`RouteFacts`) and
credentials through `CredentialStore`.

- **Three native protocols, lazy SDK loading:** OpenAI Responses (HTTP +
  WebSocket), Anthropic Messages, and Google Interactions. Each binding loads
  only its own protocol's SDK on demand (OpenAI's runtime is bundled).
- **One streaming path, fail-fast preparation:** `prepareTurn` validates
  controls, history, and media before transport; `streamTurn` is the sole
  execution method (`completedTurn` collects it), so streaming and non-streaming
  cannot diverge.
- **One structured error (`ModelError`):** Branch on `kind`, `retryable`,
  `scope`, `retryAfterMs`, and `quota` instead of parsing error strings. Zero
  hidden retries.
- **Origin-checked reasoning replay:** `ModelOrigin` and `codecVersion` govern
  exact replay of reasoning signatures, encrypted reasoning, and provider
  evidence across turns and model switches.
- **Wire-tested with scrubbed cassettes:** Hermetic protocol suites plus live
  provider recordings (`test-live/cassettes/`) replayed in CI with no keys and
  no network.

> **0.x: the API may change in any minor release.** This package is versioned on
> its own, not with the TeXRA app.

## Install

Requires Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later. ESM only.
`effect` (`^4.1.3`) is a peer dependency so your install supplies one copy of
it:

```bash
npm install @texra-ai/llm effect
```

`llm-zoo` (pinned to one exact version) and the Anthropic and Google SDKs are
installed as dependencies. The root `.` entry re-exports the catalog types and
values callers need (`ModelConfig`, `MODEL_CONFIGS`, `ReasoningEffort`,
`MODELS`, …), so import them from `@texra-ai/llm` rather than from `llm-zoo`. A
binding loads only its own protocol's SDK on demand. OpenAI's runtime is
bundled, so `openai` is not installed.

A Claude Max or Team plan includes
[monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
that an Anthropic API key can spend once you link a Console organization to the
plan. A ChatGPT Pro or Business plan includes
[monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
that an OpenAI API key can spend once you claim them for an API organization you
own.

## Example

Pick a catalog model, decide its route, bind it, and run one turn. Here the key
comes from the environment. The runnable version,
[`packages/harness/example/01-llm-turn.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/01-llm-turn.ts),
passes a `fetch` that answers 401 so it needs no key.

```ts
import { Effect } from 'effect';
import {
  completedTurn,
  decideModelRoute,
  OWN_KEY_ROUTE_FACTS,
  selectModel,
} from '@texra-ai/llm';
import { bindModel } from '@texra-ai/llm/node';

const selected = selectModel('anthropic/claude-sonnet-5-5');
if (selected === undefined) throw new Error('Unknown model.');
const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);
const program = Effect.gen(function* () {
  const binding = yield* bindModel({
    model: selected.config,
    route,
    bearer: process.env.ANTHROPIC_API_KEY ?? '',
    // The app the requests are sent for: llm names no client of its own.
    client: { name: 'Example App', id: 'example-app' },
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

`bindModel` binds the model on its provider's protocol and derives what the
route fixes: the config it runs and bills with (`routeConfig`), the credential
scope on its origin, and the plan it bills. Every option has a default (the
catalog's output limit, the model's default reasoning, the provider's own
temperature, every switch off). It returns a `Binding`, holding the `Model` and
the facts its configuration fixed: origin, routed config, billing route, output
limit, background capability, service tier, and whether the route takes a forced
tool choice. The connection and any uploaded files live in the caller's `Scope`
and are released when the scope closes.

## Errors

A `Model` fails with one error type, `ModelError` (`_tag: 'ModelError'`). Fiber
interruption stays outside it. Branch on its fields, never on its message:

| Field                                        | What it says                                                                                                                                                                                                 |
| :------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                       | Failure class to branch on: `invalid-request`, `authentication`, `context-overflow`, `continuation-gone`, `transport`, `provider-rejection` (a rate limit is `status` 429; a depleted quota carries `quota`) |
| `retryable`                                  | Whether repeating the request unchanged can succeed. Defaults from `kind` and `status`; overridden where the vendor reply says more                                                                          |
| `scope`                                      | What the failure is evidence about beyond this request: `model` (one model's limit) or `route` (the provider, credential, and endpoint)                                                                      |
| `retryAfterMs`                               | The provider's retry delay, when stated                                                                                                                                                                      |
| `quota`                                      | For depleted quota: the `plan` used up (`PlanRoute`, or `null` for account credit) and reset time                                                                                                            |
| `status`, `requestId`, `responseId`, `model` | HTTP facts when the failure had a reply                                                                                                                                                                      |

The package itself retries nothing. Retry, pricing, and persistence belong to
the caller ([`@texra-ai/worldline`](../harness/README.md) is one).

The other failures are tagged errors as well:

- `SecretsFailed` from a `CredentialStore`, and from a sign-in reading or
  writing a session (`operation` names the failing store member).
- `ReasoningChoiceError` in the failure of `chooseReasoning`, for a reasoning
  request the model or route cannot carry.
- From `./node`: `SubscriptionOAuthError` (`kind` is `fatal`, `expired`,
  `transient`, or `config`; `needsReauth` says whether to sign in again) and
  `LoopbackTransportUnavailableError` (raised when browser sign-in cannot start
  so device-code sign-in can take over). Interactive sign-ins fail with a plain
  `Error` whose `message` is user-facing text.

## The entries

The package is split by where its code runs, not by topic.

| Entry    | What it holds                                                                                                                                                                                                                | Runs in      |
| :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| `.`      | Turn contract (`Model`, request/result/event schemas, `completedTurn`), `ModelError`, provider catalog and API-key lookup over `CredentialStore`, model selection, route decision and endpoint, reasoning choice, `turnCost` | Browser-safe |
| `./node` | `bindModel(spec) → Binding`, and `SubscriptionAccounts` (ChatGPT and Grok sign-in flows)                                                                                                                                     | Node         |

Every type a public signature names is exported from one of the two entries.
Generated API docs with TSDoc and declarations live in
[`docs/api/index.md`](./docs/api/index.md) and
[`docs/api/node.md`](./docs/api/node.md). Protocols (`api/`), continuation
anchors, and the upload cache are internal: `bindModel` loads the chosen
protocol with a literal `import('./api/<protocol>.js')` so a run loads only its
provider's SDK. `oxlint` (`oxlint.config.mts`) enforces the boundary: nothing
under `src/` imports another repo module, and outside `api/`, `oauth/`, and
`node.ts` nothing imports a Node built-in or vendor SDK.

Inside the workspace the entries point to TypeScript sources. `npm run build`
emits what a pack publishes (`publishConfig.exports`): one ESM bundle per entry
under `dist/`, each protocol as its own chunk, OpenAI's runtime carried inside,
and declarations with TSDoc. The artifact validator checks that no published
signature names an unexported type
(`packages/harness/scripts/forgotten-exports.mjs`).

## The contract

`src/turn.ts` defines it. Every operation returns an `Effect` or a `Stream` and
fails only with `ModelError`.

```text
prepareTurn(request) -> ResolvedTurn // freeze the binding and the controls
streamTurn(turn)     -> Stream<TurnEvent>
```

A caller that wants only the final result collects the stream with
`completedTurn(model.streamTurn(turn))`; there is no separate non-streaming
method, so the two paths cannot diverge. Preparation is where a request is
accepted or rejected: an unsupported control, unrepresentable history, or
unsupported media part fails before transport. Execution never rewrites an
accepted request.

Two optional members appear only where the binding supports them: `uploadFile`
(provider file ids held in memory only, never persisted, deleted when the
binding's `Scope` closes) on routes that accept documents, and `background`
(`submit`, `observe`, `cancel`) for protocols with remote execution. `observe`
takes the accepted turn back because a completion's continuation anchors to the
exact history prefix it covers, which the operation handle does not copy.

Every turn stores the origin it was requested on (`ModelOrigin`: protocol,
requested model, deployment, and `codecVersion`). A later request replays a
stored turn's provider-specific state (reasoning signatures, encrypted
reasoning, provider evidence) only when that origin matches its own exactly
(`sameModelOrigin`). A turn of the same protocol from another origin replays as
plain content without reasoning or evidence (`replayableHistory`); another
protocol's evidence fails explicitly in the codec. `codecVersion` changes only
when the meaning of stored state changes, so a turn a newer codec would read
differently is resent as plain content instead of misread. Adding a field or
changing request construction keeps the version. A change to the stored shape
that an older build could not decode also bumps the harness's `model.message`
row version so an older build refuses the store rather than the turn
(`ROW_KINDS`, `packages/harness/src/shared/schemas/rowVersions.ts`).

## The tree

By directory; [`docs/api/`](./docs/api/index.md) lists every export, and each
file's header says what it owns.

| Directory        | What it owns                                                                                                                                                                                                                                                                                                                                                                                      |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`           | Entries (`index.ts`, `node.ts`: `bindModel`) and shared contract: `turn.ts` (`Model`, schemas, `completedTurn`), `protocol.ts` (binding identity, origins, usage), `message.ts` (history schemas, `replayableHistory`, continuations), `errors.ts` (`ModelError`, `sdkModelError`, plans)                                                                                                         |
| `src/api/`       | Three wire protocols (codec, lowering, request per protocol), shared turn reducer (`parts.ts`, `assembleTurn.ts`), turn preparation (`turnInput.ts`), continuation prefix rules (`continuation.ts`), background work (`background.ts`), upload cache, transport helpers, bind-time rules (`configuration.ts`, `responsesConfiguration.ts`), and failure verdict (`verdict.ts`, `failureReply.ts`) |
| `src/models/`    | Model selection over `llm-zoo`, route decision and endpoint, reasoning choice, `turnCost`                                                                                                                                                                                                                                                                                                         |
| `src/providers/` | Provider plugins, API-key providers and key lookup, `CredentialStore`                                                                                                                                                                                                                                                                                                                             |
| `src/oauth/`     | `SubscriptionAccounts` coordinator, loopback and device-code sign-ins, and provider policies (`chatgpt/`, `xai/`)                                                                                                                                                                                                                                                                                 |

## Who calls it

`packages/harness/src/agent/runtime/modelAccess/ModelAccess.ts` binds a route to
a `Model`, and `packages/harness/src/agent/runtime/ModelInvoker.ts` is the sole
service that calls it across every route, helper, tool-use turn, and workflow
round. Retry lives in `ModelInvoker` (an automatic route-scoped batch under the
session's `ModelRetryGate`, and a durable human permit); none of it is in this
package.

Consumers import `@texra-ai/llm` or `@texra-ai/llm/node`, so `package.json`'s
`exports` map enforces the boundary. Tests are the exception: protocol suites in
`test/api/` and `test/llm/` reach `src/api/`, and sign-in suites in `test/auth/`
reach `src/oauth/` directly, as `test-live/` does. Inside the package imports
flow in one acyclic direction (`protocol` ← `errors` ← `message` ←
`api/transport` ← `turn`, with protocol modules below their entry), and only the
two entries re-export.

## What it deliberately does not do

Unsupported content fails explicitly; no protocol silently drops reasoning,
media, or evidence it cannot represent. Another protocol's reasoning or evidence
is refused by every codec; only another model of the same protocol replays as
plain content. Current explicit failures:

- Hosted tools: local `web_search` and `web_fetch` tools are the single system
  for web search and fetch, and codecs request no provider-hosted tool. A stream
  carrying hosted execution fails explicitly (hosted blocks fail the event
  schema as malformed output, and a paused hosted turn fails by name).
- Assistant media output, Responses service-tier billing accounting, and native
  provider compaction.
- Streaming reconnection and managed-agent execution for background work.
  Observation polls or re-reads and never creates a replacement generation.
- Remote cancellation is claimed only when the provider answers `cancelled`.
  Interrupting the local request is not an acknowledgement, and an interrupted
  submission can leave remote work whose receipt was never delivered: the
  runtime must not infer that no work happened.

## What the tests prove, and what they do not

Two tiers, kept separate:

`test/api/` and `test/llm/` hold three synthetic-transport suites (one per
protocol family, ~1,500 lines, eight cases) pinning lowering, decoding,
ordering, and explicit failures against fixtures. They stay hermetic and free,
making no network calls, and run in `npm test`.

`test-live/` is the wire evidence: one suite per HTTP provider route under
`vitest.live.config.mjs`, each running the shared case matrix
(`test-live/support.ts`). Cases skip unless that route's key is in the
environment; the rejected-credential case runs on every route. Reach it with
`npm run test:live` or the labelled job in `.github/workflows/live-llm.yml`.

Live cases talk to providers through a local HTTP or Responses WebSocket relay.
With `LLM_RECORD=1`, each passing case writes its exchanges to
`test-live/cassettes/<route>/<case>.json`, and `test/api/WireContract.vitest.ts`
replays every cassette in `npm test` with no key and no network. Cassettes never
store client request headers, bodies, or frames; response headers are
allowlisted, and bodies are scrubbed before writing (identifiers renumbered,
model text, reasoning, signatures, and tool arguments replaced with fixed
placeholders, account fields blanked). Scrubbed copies are replayed through
their case before being kept, and any credential-shaped string (`sk-`, `Bearer`,
`AIza`) fails both write and read.

What the live tier does not claim: SSE parsing belongs to the vendor SDKs, so
the package makes no bounded-stream-memory claim, and cleanup joins foreign
finalizers, so it makes no bounded-stop-latency claim either.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE.txt).
