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

Requires Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later. The
package is ESM only. `effect` (^4.1.3) is a peer dependency, so your install
supplies the one copy of it:

```bash
npm install @texra-ai/llm effect
```

`llm-zoo` (the catalog, pinned to one exact version) and the Anthropic and
Google SDKs come in as dependencies. The `.` entry re-exports the catalog
types and values a caller needs (`ModelConfig`, `MODEL_CONFIGS`,
`ReasoningEffort`, `MODELS`, …), so import them from `@texra-ai/llm`,
not from `llm-zoo`. A binding loads only its own protocol's SDK, on demand.
OpenAI's runtime is bundled, so `openai` is not installed.

A Claude Max or Team plan includes [monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) that an
Anthropic API key can spend once you link a Console organization to the plan.
A ChatGPT Pro or Business plan includes [monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
that an OpenAI API key can spend once you claim them for an API organization
you own.

## Example

Pick a catalog model, decide its route, bind it, and run one turn. Here the
key is read from the environment. The runnable version of this program,
[`packages/harness/example/01-llm-turn.ts`](https://github.com/LionSR/TeXRA/blob/main/packages/harness/example/01-llm-turn.ts),
passes a `fetch` that answers 401, so it needs no key.

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
temperature, every switch off). It returns a `Binding`, which holds the
`Model` and the facts its configuration fixed: the origin, the routed config,
the billing route, the output limit, background capability, service tier,
and whether the route takes a forced tool choice. The connection, and any files
the model uploads, live in the caller's `Scope`. Closing the scope releases
them.

## Errors

A `Model` fails with exactly one error type, `ModelError` (`_tag:
'ModelError'`). Fiber interruption stays outside it. Branch on its fields,
never on its message:

| Field                                        | What it says                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                                       | the class of failure, each one a reader decides on: `invalid-request`, `authentication`, `context-overflow`, `continuation-gone`, `transport`, `provider-rejection` (a rate limit is `status` 429, a used-up quota is `quota`) |
| `retryable`                                  | whether repeating the request unchanged can succeed. It defaults from `kind` and `status`; the binding overrides it where the vendor's reply says more                                                                         |
| `scope`                                      | what the failure is evidence about beyond this request: `model` (a limit on one model) or `route` (the provider, credential and endpoint)                                                                                      |
| `retryAfterMs`                               | the provider's own "come back in" delay, when its reply stated one                                                                                                                                                             |
| `quota`                                      | for a failure that used up a quota: the `plan` used up (a `PlanRoute`, or `null` for the account's credit), and when it resets                                                                                                 |
| `status`, `requestId`, `responseId`, `model` | the HTTP facts, when the failure had a reply                                                                                                                                                                                   |

The package itself retries nothing. Retry,
pricing and persistence belong to the caller
([`@texra-ai/harness`](../harness/README.md) is one).

The other failures are tagged errors too:

- `SecretsFailed` from a `CredentialStore`, and from a sign-in that reads
  or writes the session. Its `operation` names the store member that failed.
- `ReasoningChoiceError` in the failure of the `Result` `chooseReasoning`
  returns, for a reasoning request the model or its route cannot carry.
- From `./node`: `SubscriptionOAuthError`, whose `kind` is `fatal`,
  `expired`, `transient` or `config` and whose `needsReauth` says whether to
  sign in again. Also `LoopbackTransportUnavailableError`, raised when the
  browser sign-in cannot start, so the device-code sign-in can take over.
  The sign-ins fail with a plain `Error` whose `message` is the text to show
  the user.

## The entries

The package is split by where its code runs, not by topic.

| Entry    | What it holds                                                                                                                                                                                                                                         | Runs in      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `.`      | the turn contract (`Model`, the request, result and event schemas, `completedTurn`), `ModelError`, the provider catalog and API-key lookup over `CredentialStore`, model selection, the route decision and endpoint, the reasoning choice, `turnCost` | browser-safe |
| `./node` | `bindModel(spec) → Binding`, and `SubscriptionAccounts`: the ChatGPT and Grok accounts, each running its own sign-in                                                                                                                                  | Node         |

Every type a public signature names is exported from one of the two entries.
Each entry's exports, with their TSDoc and declarations, are listed in
[`docs/api/index.md`](./docs/api/index.md) and
[`docs/api/node.md`](./docs/api/node.md), generated from the source.
The protocols (`api/`), the continuation anchor and the upload cache are
internal: `bindModel` loads the chosen protocol with a literal
`import('./api/<protocol>.js')`, so a run loads only its provider's SDK.
oxlint holds the rest (`oxlint.config.mts`): nothing under `src/` imports another repo module, and
outside `api/`, `oauth/` and `node.ts` nothing imports a Node built-in or a
vendor SDK.

Inside the workspace the entries are the TypeScript sources. `npm run build`
writes what a pack publishes (`publishConfig.exports`): one ESM bundle per
entry under `dist/`, each protocol a chunk, OpenAI's runtime carried
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

Two optional members, present only where the binding serves them:
`uploadFile` (provider file ids, held in the model's memory only and never
persisted, and deleted when the binding's `Scope` closes), on a route that
takes documents, and `background` (`submit`, `observe`, `cancel`) for the
protocols with remote execution. `observe` takes the accepted turn back
because a completion's continuation anchors to the exact history prefix it
covers, which the operation handle deliberately does not copy.

Every turn stores the origin it was requested on (`ModelOrigin`: protocol,
requested model, deployment and `codecVersion`). A later request replays a
stored turn's provider-specific state (reasoning signatures, encrypted
reasoning, provider evidence) only when that origin matches its own exactly
(`sameModelOrigin`). A turn of the same protocol from another origin is sent
as plain content, without its reasoning and evidence, as after a model
switch (`replayableHistory`); another protocol's evidence fails explicitly in
the codec. `codecVersion` changes only when the meaning of that stored state
changes, so a turn a newer codec would read differently is resent as plain
content instead of misread. Adding a field or changing how a request is
built keeps the version. A turn of another version must still decode, so
`codecVersion` covers a change of meaning only. A change to the stored
shape of that state, one an older build could not decode, also bumps the
harness's `model.message` row version, and an older build then refuses the
store rather than the turn (`ROW_KINDS`, `packages/harness/src/shared/schemas/rowVersions.ts`).

## The tree

By directory; the generated pages in [`docs/api/`](./docs/api/index.md) list
every export, and each file's header says what it owns.

| Directory        | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`           | the two entries (`index.ts`, `node.ts`: `bindModel`) and the contract they share: `turn.ts` (the `Model` interface, request, configuration, result and event schemas, `completedTurn`), `protocol.ts` (binding identity, origins, usage), `message.ts` (the history schemas, the prepared-history rules, `replayableHistory`, the continuation schemas), `errors.ts` (`ModelError`, `sdkModelError`, the plans)                                                                                                                   |
| `src/api/`       | the three protocols, each an entry module with its own codec, lowering and request modules; what they share: the part events and the one turn reducer (`parts.ts`, `assembleTurn.ts`), turn preparation (`turnInput.ts`), the stored continuation's prefix rules (`continuation.ts`), background work (`background.ts`), the upload cache, the transport helpers; and the bind-time rules (`configuration.ts`, `responsesConfiguration.ts`) and failure verdict (`verdict.ts` over `failureReply.ts`) `bindModel` loads on demand |
| `src/models/`    | model selection over llm-zoo, the route decision and the config and endpoint it fixes, the reasoning choice, a turn's cost                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/providers/` | the provider plugins, the API-key providers and their key lookup, `CredentialStore`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/oauth/`     | the subscription accounts (`SubscriptionAccounts`) over one coordinator, the loopback and device-code sign-ins it runs, and each provider's policy (`chatgpt/`, `xai/`)                                                                                                                                                                                                                                                                                                                                                           |

## Who calls it

`packages/harness/src/agent/runtime/modelAccess/ModelAccess.ts` binds a route to a `Model`, and
`packages/harness/src/agent/runtime/ModelInvoker.ts` is the one service that calls it — every
route, helper, tool-use turn and workflow round included. Retry has two owners
inside `ModelInvoker` (an automatic route-scoped batch under the session's
`ModelRetryGate`, and a durable human permit); none of it is in this package.

Every consumer imports `@texra-ai/llm` or `@texra-ai/llm/node`, so
`package.json`'s `exports` map is the boundary the resolver enforces: a module
this package does not export cannot be reached from outside it. Tests are the
one exception: the protocol suites in `test/api/` and `test/llm/` reach
`src/api/` and the sign-in suites in `test/auth/` reach `src/oauth/` by
relative path, as `test-live/` does. Inside the package a module imports the file that defines a
symbol, in one acyclic direction — `protocol` ← `errors` ← `message` ←
`api/transport` ← `turn`, with each protocol's own modules below its entry —
and the only files that re-export are the two entries, whose published names
are contract.

## What it deliberately does not do

Unsupported content fails explicitly; no protocol silently discards reasoning,
media or evidence it cannot represent. Another protocol's reasoning or
evidence is refused by every codec; only another model of the same protocol
replays as plain content, by the contract above. The current explicit
failures:

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

`test/api/` and `test/llm/` hold three synthetic-transport suites, one per
protocol family, about 1 500 lines and eight cases: they pin lowering, decoding, ordering
and the explicit failures they name, against fixtures. They stay hermetic and free, so no suite in them calls a provider, and they run
in `npm test`.

`test-live/` is the wire evidence: one suite per HTTP provider route, behind
`vitest.live.config.mjs`, each running the same case matrix
(`test-live/support.ts`). A case that needs a credential skips unless the
route's own key is in the environment, so a run with one key exercises one
route; the rejected-credential case presents a key no provider issued and
runs on every route. It is deliberately not part of `npm test`: reach it by
name (`npm run test:live`) or through the labelled job in
`.github/workflows/live-llm.yml`.

A live case reaches its provider through a local relay, over HTTP or the
Responses WebSocket. Run with
`LLM_RECORD=1`, each passing case's exchanges are written to
`test-live/cassettes/<route>/<case>.json`, and
`test/api/WireContract.vitest.ts` replays every cassette there in `npm test`,
with no key and no network. A cassette never holds a request header, a
request body or a frame the client sent; its response headers are allowlisted, and its bodies are
scrubbed before they are written: identifiers renumbered, model text,
reasoning, signatures and tool arguments replaced by fixed placeholders,
account fields blanked. The scrubbed copy is replayed through its case before
it is kept, and a cassette holding a credential-shaped string (`sk-`,
`Bearer`, `AIza`) is refused on write and on read. Review a recorded diff
before committing it.

What the live tier does not claim: SSE parsing belongs to the vendor SDKs, so
the package makes no bounded-stream-memory claim, and cleanup joins foreign
finalizers, so it makes no bounded-stop-latency claim either.
