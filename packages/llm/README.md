# @texra-ai/llm

TeXRA's own provider layer: one contract over twelve wire protocols. A
`Model` is a configured executable value. It owns the wire — lowering a turn,
decoding the stream, classifying the failure — and nothing else. Conversation,
retry, pricing, approval, budgets and persistence are the runtime's, and the
package is pure: no `platform()`, no `Effect.run*`, no `AbortController`, no
`vscode`. Its only dependencies are the provider SDKs, `ws`, and `effect` and
`zod` as peers.

Private workspace package, built from source through the workspace, not
published.

## The contract

`src/turn.ts` defines it. Every operation returns an `Effect` or a `Stream`
and fails only with `ModelError`.

```ts
prepareTurn(request) -> ResolvedTurn // freeze the binding and the controls
streamTurn(turn)     -> Stream<TurnEvent>
generateTurn(turn)   -> Effect<TurnResult>
```

`generateTurn` is a fold over `streamTurn`'s events (`completedTurn`), so the
streaming and non-streaming paths cannot diverge. Preparation is where a
request is admitted or rejected: an unsupported control, an unrepresentable
history or an unsupported media part fails there, before transport. Execution
never rewrites an admitted request.

Four optional members, present only where the binding serves them:
`uploadFile` / `releaseUploads` (provider file ids, held in the model's memory
only and never persisted), `estimateInputTokens` (a counted scope, not a bill
or an allowance), and `background` (`submit`, `observe`, `cancel`) for the
protocols with remote execution. `observe` takes the admitted turn back
because a completion's continuation anchors to the exact history prefix it
covers, which the operation handle deliberately does not copy.

## The tree

Nineteen files, about 10 750 lines. No file exceeds 1 500 lines, and the
file-size ratchet holds every one of them at or under its current count.

| File                          | What it owns                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.ts`                     | the subpath's public entry: the `Model` interface, the request, configuration, result and event contract, the tool and reasoning schemas, `completedTurn` |
| `protocol.ts`                 | the protocol enum, binding identity (`BindingSchema`, `OriginSchema`, `ModelOriginSchema`) and JSON materialization                                       |
| `message.ts`                  | the wire message and history schemas, the content parts, and the continuation prefixes                                                                    |
| `errors.ts`                   | `ModelError` and the failure classification along it, `RemoteOperation` included                                                                          |
| `transport.ts`                | SSE decode, stream pull, tool-argument parsing, the abort-safe request helper                                                                             |
| `openaiChat.ts`               | `openaiChatModel`: `openai-chat` and the direct `deepseek-chat`, `kimi-chat`, `glm-chat`, `xai-chat`, `dashscope-chat` and `minimax-chat` branches        |
| `openaiChatChunks.ts`         | the OpenAI-compatible chunk vocabulary and the MiniMax-only decode helpers                                                                                |
| `openaiResponses.ts`          | `openaiResponsesModel`, and the subpath's re-exports of the continuation and the WebSocket model                                                          |
| `openaiResponsesCodec.ts`     | the response-side schemas and normalization, content lowering, event decoding                                                                             |
| `openaiResponsesLower.ts`     | input lowering and the continuation anchor                                                                                                                |
| `openaiResponsesRequest.ts`   | preparing a turn, its parameters, the abort classification, the input estimate                                                                            |
| `openaiResponsesWebSocket.ts` | the experimental WebSocket transport                                                                                                                      |
| `anthropicMessages.ts`        | `anthropicMessagesModel`                                                                                                                                  |
| `googleInteractions.ts`       | `googleInteractionsModel`                                                                                                                                 |
| `openrouterChat.ts`           | `openrouterChatModel`                                                                                                                                     |
| `chatStream.ts`               | the shared Chat SSE decode loop                                                                                                                           |
| `uploadCache.ts`              | the digest-keyed, model-scoped upload cache behind `uploadFile`                                                                                           |
| `prefixFingerprint.ts`        | the admitted-history fingerprint a background completion anchors on                                                                                       |
| `openaiError.ts`              | SDK error classification into `ModelError`                                                                                                                |

The twelfth protocol, `vscode-lm`, cannot live here: it is acquired from the
editor. `packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts`
implements the same `Model` contract against `vscode.lm`, captures one
concrete model with its exact vendor, id and version, and rejects a foreign or
retired acquisition rather than silently selecting a replacement.

## Who calls it

`src/agent/runtime/run/modelBinding.ts` binds a route to a `Model`, and
`src/agent/runtime/ModelInvoker.ts` is the one service that calls it — every
route, helper, tool-use turn and workflow round included. Retry has two owners
inside `ModelInvoker` (an automatic route-scoped batch under the session's
`ModelRetryGate`, and a durable human permit); none of it is in this package.

Every consumer imports `@texra-ai/llm/<subpath>`, so `package.json`'s
`exports` map is the boundary the resolver enforces: a module this package
does not export cannot be reached from outside it. The `@llm/*` tsconfig
alias that used to expand to a filesystem path and bypass the map is gone.
Inside the package a module imports the file that defines a symbol, in one
acyclic direction — `protocol` ← `message` ← `errors` ← `transport` ← `turn`,
with each protocol's own modules below its entry — and the only files that
re-export are the subpath entries, whose published names are contract.

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
  provider compaction, and OpenRouter continuation and token estimation.
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

`test-live/` is the wire evidence: one key-gated suite per HTTP protocol,
eleven of the twelve, behind `vitest.live.config.mjs`. Each suite skips itself
unless its own key is in the environment, so a run with one key exercises one
protocol and skips the other ten. It is deliberately not part of `npm test`: reach it by name
(`npm run test:live`) or through the labelled job in
`.github/workflows/live-llm.yml`. `vscode-lm`, the twelfth protocol, has no
suite there — it is acquired through the extension host's `vscode.lm` API, so
its live check belongs to an Extension Development Host job.

What the live tier does not claim: the SSE parser's event-size cap is still
explicitly disabled (`maxEventSize: Number.POSITIVE_INFINITY`), so the package
makes no bounded-stream-memory claim, and cleanup joins foreign finalizers, so
it makes no bounded-stop-latency claim either.

## Background

[The package study](../../.agents/docs/implemented/architecture/2026-09-06-llm-package-architecture-study.md)
and
[the joint runtime contract](../../.agents/docs/implemented/architecture/2026-09-06-llm-runtime-contract.md)
are the design this package implements.
