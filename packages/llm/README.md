<div align="center">

# `@texra-ai/llm`

**One pure Effect `Model` over OpenAI Responses, Anthropic Messages, and Google
Interactions.**<br />
10 providers, 140+ `llm-zoo` models, typed `ModelError`, lazy SDK loading, and
subscription sign-in. From [TeXRA](https://texra.ai).

[![npm](https://img.shields.io/badge/npm-%40texra--ai%2Fllm_0.1.0-6F387A?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/llm)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Catalog: llm-zoo](https://img.shields.io/badge/Catalog-llm--zoo-6F387A?style=flat)](https://github.com/texra-ai/llm-zoo)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-270939?style=flat)](./LICENSE.txt)

[Protocols](#protocols-and-providers) · [Quick Start](#quick-start) · [Errors](#errors) · [Entries](#entry-points) · [Turn Contract](#the-contract) · [API Reference](./docs/api/index.md)

</div>

---

> **0.x notice:** Versioned independently from TeXRA; the API may change in
> minor 0.x releases.

## Why `@texra-ai/llm`

`@texra-ai/llm` is the pure model layer underneath
[`@texra-ai/worldline`](../harness/README.md). It owns routing, streaming,
normalization, and failure classification, leaving conversation state, retries,
budgets, and persistence to the caller.

- **Three native frontier protocols, lazy SDK loading:** OpenAI Responses
  (HTTP + WebSocket), Anthropic Messages, and Google Interactions. Each binding
  loads only its own protocol's SDK on demand (OpenAI's runtime is bundled).
- **One streaming path, fail-fast preparation:** `prepareTurn` rejects invalid
  controls, history, or media before transport. `streamTurn` is the sole
  execution method (`completedTurn` collects it), so streaming and non-streaming
  cannot diverge.
- **One typed error (`ModelError`):** Branch on `kind`, `retryable`, `scope`,
  `retryAfterMs`, and `quota` instead of parsing error strings. Zero hidden
  retries.
- **Origin-safe reasoning replay:** `ModelOrigin` and `codecVersion` govern
  exact replay of encrypted reasoning and signatures across turns and model
  switches; unsupported content fails explicitly instead of being silently
  dropped.
- **Live-recorded wire cassettes in CI:** Hermetic protocol suites plus scrubbed
  recordings from real provider traffic (`test-live/cassettes/`) replayed in
  `npm test` with no keys or network.

## Protocols and providers

| Wire protocol           | Providers                                                                                                                                                                                                                   | Notes                                    |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- |
| **OpenAI Responses**    | OpenAI (API + ChatGPT subscription), DeepSeek, xAI Grok (API + Grok subscription), Moonshot Kimi (API + Kimi Code), Alibaba Qwen (DashScope), Zhipu GLM (API + Coding Plan), MiniMax, Meta Muse, custom Responses endpoints | HTTP + WebSocket; OpenAI runtime bundled |
| **Anthropic Messages**  | Anthropic Claude, custom Messages endpoints                                                                                                                                                                                 | `@anthropic-ai/sdk` loaded on demand     |
| **Google Interactions** | Google Gemini, custom Interactions endpoints                                                                                                                                                                                | `@google/genai` loaded on demand         |

140+ models, context windows, reasoning efforts, and pricing come from
[`llm-zoo`](https://github.com/texra-ai/llm-zoo) (re-exported from
`@texra-ai/llm` so callers never depend on `llm-zoo` directly).

## Quick start

Requires Node.js 22.22.2+ (22.x) or 24.15+, ESM only, peer `effect` (`^4.1.3`):

```bash
npm install @texra-ai/llm effect
```

Pick a model, decide its route, bind it inside a `Scope` (closing the scope
releases connections and uploaded files), and run a turn
([runnable offline version](../harness/example/01-llm-turn.ts)):

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
if (!selected) throw new Error('Unknown model.');
const route = decideModelRoute(selected.config, OWN_KEY_ROUTE_FACTS);
if (route.kind !== 'api-key') throw new Error(`Unexpected route ${route.kind}`);

const program = Effect.gen(function* () {
  const binding = yield* bindModel({
    model: selected.config,
    route,
    bearer: process.env.ANTHROPIC_API_KEY ?? '',
    client: { name: 'Example App', id: 'example-app' },
  });
  const turn = yield* binding.model.prepareTurn({
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello.' }] }],
  });
  if (turn.mode !== 'foreground') throw new Error('Expected foreground turn.');
  return yield* completedTurn(binding.model.streamTurn(turn));
}).pipe(
  Effect.scoped,
  Effect.catchTag('ModelError', (e) =>
    Effect.fail(new Error(`${e.kind}: ${e.message}`)),
  ),
);

const result = await Effect.runPromise(program);
console.log(result.content);
```

Paid Claude Max/Team ([monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers))
and ChatGPT Pro/Business ([monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions))
plans work with standard Anthropic or OpenAI API keys once linked to an API org.

## Errors

A `Model` fails only with `ModelError` (`_tag: 'ModelError'`; fiber interruption
stays outside it):

| Field                                        | Meaning                                                                                                                                                                    |
| :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                       | `invalid-request`, `authentication`, `context-overflow`, `continuation-gone`, `transport`, `provider-rejection` (`status: 429` for rate limit, `quota` for depleted quota) |
| `retryable`                                  | Whether repeating unchanged can succeed (vendor-adjusted)                                                                                                                  |
| `scope`                                      | `model` (limit on one model) or `route` (provider, credential, endpoint)                                                                                                   |
| `retryAfterMs`                               | Provider-stated backoff delay, when present                                                                                                                                |
| `quota`                                      | `{ plan, resetsAt }` when a subscription or account quota is exhausted                                                                                                     |
| `status`, `requestId`, `responseId`, `model` | HTTP reply metadata, when available                                                                                                                                        |

Other tagged errors: `SecretsFailed` (`CredentialStore`),
`ReasoningChoiceError` (`chooseReasoning`), and from `./node`:
`SubscriptionOAuthError` (`fatal`, `expired`, `transient`, `config`;
`needsReauth`) and `LoopbackTransportUnavailableError` (falls back to device
code).

## Entry points

| Entry    | Contents                                                                                                                                                                                              | Runs in      |
| :------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| `.`      | `Model`, turn/result/event schemas, `completedTurn`, `ModelError`, provider catalog, `CredentialStore` lookup, `selectModel`, `decideModelRoute`, `chooseReasoning`, `turnCost`, `llm-zoo` re-exports | Browser-safe |
| `./node` | `bindModel(spec) → Binding`, `SubscriptionAccounts` (ChatGPT and Grok sign-in)                                                                                                                        | Node         |

Generated API docs: [`docs/api/index.md`](./docs/api/index.md) and
[`docs/api/node.md`](./docs/api/node.md).

## The contract

```text
prepareTurn(request) -> ResolvedTurn      // validates controls, history, and media before transport
streamTurn(turn)     -> Stream<TurnEvent> // single execution path; completedTurn collects the result
```

- **Optional capabilities:** `uploadFile` (ephemeral provider file IDs deleted
  when the binding's `Scope` closes) and `background` (`submit`, `observe`,
  `cancel` for remote execution; `observe` polls/re-reads and never spawns a
  replacement generation).
- **Origin-checked replay:** Every turn stamps `ModelOrigin` (protocol, model,
  deployment, `codecVersion`). Reasoning signatures and encrypted reasoning
  replay only on exact origin match (`sameModelOrigin`); same-protocol switches
  replay as plain content (`replayableHistory`); cross-protocol evidence fails
  explicitly.
- **Explicit non-goals (fail loudly rather than silently):** Provider-hosted
  tools, assistant media output, Responses service-tier billing accounting,
  native provider compaction, streaming reconnection for background jobs, and
  unacknowledged remote cancellation (claimed only when the provider replies
  `cancelled`).

<details>
<summary><strong>Package layout and wire-contract testing</strong></summary>

- **Source tree:** `src/` (`index.ts`, `node.ts`, `turn.ts`, `protocol.ts`,
  `message.ts`, `errors.ts`), `src/api/` (three protocol codecs, shared
  `assembleTurn`, `turnInput`, `continuation`, `background`, `verdict`),
  `src/models/` (`llm-zoo` selection, routing, reasoning, `turnCost`),
  `src/providers/`, `src/oauth/` (`SubscriptionAccounts`, `chatgpt/`, `xai/`).
  Imports stay strictly acyclic and `oxlint` enforces browser-safety on `.`.
  `npm run build` emits ESM bundles per entry with protocol chunks and runs
  `packages/harness/scripts/forgotten-exports.mjs`.
- **Two test tiers:** Hermetic protocol suites (`test/api/`, `test/llm/`, ~1,500
  lines) run in `npm test`. Live wire suites (`test-live/`, `npm run test:live`)
  talk to providers through a local HTTP/WebSocket relay; with `LLM_RECORD=1`,
  scrubbed cassettes (no client headers/bodies, allowlisted response headers,
  redacted text/reasoning/secrets verified on write and read) are saved to
  `test-live/cassettes/` and replayed offline by `WireContract.vitest.ts`.
- **Non-claims:** SSE parsing belongs to vendor SDKs (no bounded-stream-memory
  claim), and cleanup joins foreign finalizers (no bounded-stop-latency claim).

</details>

## License

Licensed under the [Apache License, Version 2.0](./LICENSE.txt).
