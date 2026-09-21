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

Ten files, about 10 500 lines.

| File                    | What it owns                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.ts`               | the `Model` interface, the protocol enum, messages, request, configuration, result and event schemas, `ModelError`, SSE, stream pull, tool-argument parsing, the abort-safe request helper |
| `openaiChat.ts`         | `openaiChatModel`: `openai-chat` and the direct `deepseek-chat`, `kimi-chat`, `glm-chat`, `xai-chat`, `dashscope-chat` and `minimax-chat` branches |
| `openaiResponses.ts`    | `openaiResponsesModel`, `openaiResponsesWebSocketModel`, and the pure `openaiResponsesContinuation`                                            |
| `anthropicMessages.ts`  | `anthropicMessagesModel`                                                                                                                       |
| `googleInteractions.ts` | `googleInteractionsModel`                                                                                                                      |
| `openrouterChat.ts`     | `openrouterChatModel`                                                                                                                          |
| `chatStream.ts`         | the shared Chat SSE decode loop                                                                                                                |
| `uploadCache.ts`        | the digest-keyed, model-scoped upload cache behind `uploadFile`                                                                                |
| `prefixFingerprint.ts`  | the admitted-history fingerprint a background completion anchors on                                                                            |
| `openaiError.ts`        | SDK error classification into `ModelError`                                                                                                     |

The twelfth protocol, `vscode-lm`, cannot live here: it is acquired from the
editor. `packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts`
implements the same `Model` contract against `vscode.lm`, captures one
concrete model with its exact vendor, id and version, and rejects a foreign or
retired acquisition rather than silently selecting a replacement.

## Who calls it

`src/agent/runtime/run/modelBinding.ts` binds a route to a `Model`, and
`src/agent/runtime/ModelInvoker.ts` is the one service that calls it — every
route, helper, tool-use and reflection turn included. Retry has two owners
inside `ModelInvoker` (an automatic route-scoped batch under the session's
`ModelRetryGate`, and a durable human permit); none of it is in this package.

The boundary is nominal today: all 46 import sites reach the source through
the `@llm/*` tsconfig alias, which `scripts/aliasUtils.mjs` expands to a
filesystem path, so `package.json`'s `exports` map is never consulted. Closing
that, and splitting `turn.ts`, are owned by
[the hardening note](../../.agents/docs/proposed/architecture/2026-09-20-llm-package-hardening.md).

## What it deliberately does not do

Unsupported content fails explicitly; no protocol silently discards reasoning,
media or evidence it cannot represent. The current explicit failures:

- Hosted tools. OpenAI Responses `web_search` and Anthropic search and fetch
  are not implemented in the codecs — Anthropic's rejects hosted-tool
  accounting by name. These worked on the deleted model handlers; restoring
  them or ruling them out of 1.0 is the hardening note's second change.
- Assistant media output, Responses service-tier billing accounting, native
  provider compaction, and OpenRouter continuation and token estimation.
- Streaming reconnection and managed-agent execution for background work.
  Observation polls or re-reads; it never creates a replacement generation.
- Remote cancellation is only ever claimed when the provider answers
  `cancelled`. Interrupting the local request is not an acknowledgement, and
  an interrupted submission can leave remote work whose receipt was never
  delivered: the runtime must not infer that no work happened.

## What the tests prove, and what they do not

`src/test-kernel/llm/` is about 9 700 lines of synthetic-transport suites: they
pin lowering, decoding, ordering and every explicit failure, against fixtures.
No suite calls a provider. There is no live-provider evidence for any of the
twelve protocols, MiniMax's incremental streaming route included. The SSE
parser's event-size cap is explicitly disabled
(`maxEventSize: Number.POSITIVE_INFINITY`), so the package makes no
bounded-stream-memory claim, and cleanup joins foreign finalizers, so it makes
no bounded-stop-latency claim either. The live tier that would close this is
the hardening note's first change.

## Background

[The package study](../../.agents/docs/implemented/architecture/2026-09-06-llm-package-architecture-study.md)
and
[the joint runtime contract](../../.agents/docs/implemented/architecture/2026-09-06-llm-runtime-contract.md)
are the design this package implements.
