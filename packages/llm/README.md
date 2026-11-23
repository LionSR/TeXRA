<div align="center">

# `@texra-ai/llm`

**One pure Effect `Model` over OpenAI Responses, Anthropic Messages, and Google Interactions.**<br />
10 providers, 140+ `llm-zoo` models, typed `ModelError`, lazy SDK loading, and subscription sign-in.

[![npm](https://img.shields.io/badge/npm-%40texra--ai%2Fllm_0.1.0-6F387A?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/llm)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Catalog: llm-zoo](https://img.shields.io/badge/Catalog-llm--zoo-6F387A?style=flat)](https://github.com/texra-ai/llm-zoo)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-270939?style=flat)](./LICENSE.txt)

[Protocols](#protocols-and-providers) · [Quick Start](#quick-start) · [Why `@texra-ai/llm`](#why-texra-aillm) · [Entries](#entry-points) · [API Reference](./docs/api/index.md)

</div>

---

> **0.x notice:** Versioned independently from TeXRA; APIs may change before 1.0.

The pure model layer behind [`@texra-ai/worldline`](../harness/README.md). Owns
model routing, wire streaming, reasoning replay, and structured failure
classification, leaving state, retries, budgets, and persistence to the caller.

## Protocols and providers

| Wire protocol           | Providers                                                                                                                                                                                                       | Notes                                    |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- |
| **OpenAI Responses**    | OpenAI (API + ChatGPT subscription), DeepSeek, xAI Grok (API + Grok subscription), Moonshot Kimi (API + Kimi Code), Alibaba Qwen, Zhipu GLM (API + Coding Plan), MiniMax, Meta Muse, custom Responses endpoints | HTTP + WebSocket; OpenAI runtime bundled |
| **Anthropic Messages**  | Anthropic Claude, custom Messages endpoints                                                                                                                                                                     | `@anthropic-ai/sdk` loaded on demand     |
| **Google Interactions** | Google Gemini, custom Interactions endpoints                                                                                                                                                                    | `@google/genai` loaded on demand         |

140+ models, context windows, reasoning efforts, and pricing come from
[`llm-zoo`](https://github.com/texra-ai/llm-zoo) (re-exported from `@texra-ai/llm`).

## Quick start

Node.js 22.22.2+ (22.x) or 24.15+, ESM only, peer `effect` (`^4.1.3`):

```bash
npm install @texra-ai/llm effect
```

Bind a model inside a `Scope` (closing releases connections and uploaded files)
and run a turn ([runnable offline version](../harness/example/01-llm-turn.ts)):

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

## Why `@texra-ai/llm`

- **Single streaming path, fail-fast prep:** `prepareTurn` rejects invalid
  controls, history, or media before transport; `streamTurn` is the sole
  execution method (`completedTurn` collects it), so streaming and non-streaming
  never diverge.
- **One typed error (`ModelError`):** Branch on `kind` (`invalid-request`,
  `authentication`, `context-overflow`, `continuation-gone`, `transport`,
  `provider-rejection`), `retryable`, `scope` (`model` | `route`),
  `retryAfterMs`, and `quota` instead of parsing strings. Zero hidden retries.
- **Origin-safe reasoning replay:** Every turn stamps `ModelOrigin` (protocol,
  model, deployment, `codecVersion`). Encrypted reasoning and signatures replay
  only on exact origin match; same-protocol switches replay as plain content;
  unsupported content fails explicitly rather than dropping silently.
- **Lazy SDKs & live-recorded CI cassettes:** Bindings load only their own
  protocol's SDK on demand, and real provider exchanges are recorded, scrubbed,
  and replayed offline in `npm test`.

## Entry points

| Entry    | Contents                                                                                                                                                                     | Runs in      |
| :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| `.`      | `Model`, schemas, `completedTurn`, `ModelError`, provider catalog, `CredentialStore`, `selectModel`, `decideModelRoute`, `chooseReasoning`, `turnCost`, `llm-zoo` re-exports | Browser-safe |
| `./node` | `bindModel(spec) → Binding`, `SubscriptionAccounts` (ChatGPT and Grok sign-in)                                                                                               | Node         |

Generated API docs: [`docs/api/index.md`](./docs/api/index.md) · [`docs/api/node.md`](./docs/api/node.md)

<details>
<summary><strong>Errors, optional capabilities, explicit non-goals, and wire testing</strong></summary>

- **Other tagged errors:** `SecretsFailed` (`CredentialStore`),
  `ReasoningChoiceError` (`chooseReasoning`), and from `./node`:
  `SubscriptionOAuthError` (`fatal`, `expired`, `transient`, `config`;
  `needsReauth`) and `LoopbackTransportUnavailableError` (falls back to device
  code).
- **Optional `Model` capabilities:** `uploadFile` (ephemeral provider file IDs
  deleted on `Scope` close) and `background` (`submit`, `observe`, `cancel`;
  `observe` never creates a replacement generation).
- **Explicit non-goals (fail loudly):** Provider-hosted tools, assistant media
  output, Responses service-tier billing accounting, native provider compaction,
  streaming reconnection for background jobs, and unacknowledged remote
  cancellation (claimed only when the provider replies `cancelled`).
- **Testing & layout:** Hermetic protocol suites (`test/api/`, `test/llm/`) plus
  live wire suites (`test-live/`, `npm run test:live`) that record scrubbed
  cassettes (`LLM_RECORD=1`) replayed offline by `WireContract.vitest.ts`. SSE
  parsing belongs to vendor SDKs (no bounded-stream-memory claim) and cleanup
  joins foreign finalizers (no bounded-stop-latency claim). Paid Claude Max/Team
  and ChatGPT Pro/Business plans include monthly API credits usable with
  standard API keys.

</details>

## License

Licensed under [Apache-2.0](./LICENSE.txt).
