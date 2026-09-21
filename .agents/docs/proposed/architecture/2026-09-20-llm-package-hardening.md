---
created: 2026-09-20
status: proposed
---

# LLM package hardening: migrated, not yet trustworthy

Baseline when written: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](./2026-09-20-post-refactor-architecture-survey.md).
Follows the 2026-09-06 [package study](../../implemented/architecture/2026-09-06-llm-package-architecture-study.md)
and [runtime contract](../../implemented/architecture/2026-09-06-llm-runtime-contract.md), both of which are
substantially executed and moved to `implemented/` with this note.

## 0. Landed since this note was written (2026-09-21)

Re-derived against `main` at `068c5f5d33` and, for the split, rebased onto
`08ee302ea6`. Four of the five changes below are
done; the fifth needs an owner decision and is the only thing this note still
asks for.

- **Change 1, the live tier — landed (#12919).** `packages/llm/vitest.live.config.mjs`
  and `packages/llm/test-live/` hold eleven `*.live.ts` suites, one per HTTP
  protocol, each key-gated on its own environment variable and reached only by
  `npm run test:live` or the labelled job in `.github/workflows/live-llm.yml`.
  `vscode-lm` stays the extension host's, as this note planned.
- **Change 3, the source split — landed (2026-09-21).** `turn.ts` (2 063 lines)
  is now the turn contract's entry (1 089) over `protocol.ts`, `message.ts`,
  `errors.ts` and `transport.ts`; `openaiResponses.ts` (2 698) is the subpath
  entry (838) over `openaiResponsesCodec.ts`, `openaiResponsesLower.ts`,
  `openaiResponsesRequest.ts` and `openaiResponsesWebSocket.ts`; `openaiChat.ts`
  (1 630) is 1 391 over `openaiChatChunks.ts`. Every `@texra-ai/llm/<subpath>`
  name is unchanged and the `exports` map is untouched, so no consumer or suite
  moved. No file in `packages/llm/src` exceeds the 1 500-line bound any more
  (the largest is `googleInteractions.ts` at 1 413); the file-size ratchet rows
  came down with the files and one row was added for the 812-line codec.
- **Change 4, the boundary — landed (#12915).** The `@llm/*` tsconfig alias is
  gone, every consumer imports `@texra-ai/llm/<subpath>`, and a module the
  package does not export can no longer be reached from outside it.
- **Change 5, the README — landed (2026-09-21).** `packages/llm/README.md` now
  describes the tree, the two test tiers and the remaining caveats as they are,
  and the two 09-06 design documents had already moved to `implemented/`.
- **Change 2 is the open item.** It is a capability decision, not cleanup: see
  [§5](#5-what-is-still-open).

## 1. What is done

`packages/llm` is a pure workspace package (19 files, about 10.75k lines): zero
`platform()`, zero `Effect.run*`, zero `AbortController`; dependencies are the
provider SDKs, `ws`, and `effect`/`zod` as peers. The `Model` contract is
`prepareTurn`, then `streamTurn` or `generateTurn`, where `generateTurn` is a
fold over the stream so the two cannot diverge. Twelve protocols through six
factories plus the VS Code language-model host. Retry and pricing sit in the
runtime. The model-handler hierarchy has zero references (#12320); every
route, helper, tool-use and reflection call goes through `ModelInvoker`.

## 2. What is not

| Gap                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted tools regressed                          | OpenAI web search and Anthropic search and fetch worked on the deleted handlers; the codecs fail explicitly (`anthropicMessages.ts:680`, "Anthropic hosted-tool accounting is not supported by this codec", beside the unsettled-content arm at `:708`), and on the Responses side a `web_search_call` item has no arm at all: it fails the output-item schema as a generic parse error (`openaiResponsesCodec.ts:35`, `"The response snapshot is malformed or unsupported."` at `:539`). The 2026-09-07 comparison required closing this before retiring the routes. It is the one change left, and it is an owner decision |
| Unimplemented, and documented as such           | assistant media output, Responses service-tier billing accounting, native provider compaction, OpenRouter continuation and token estimation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| No bounded-memory or bounded-stop-latency claim | the SSE parser's event-size cap is disabled (`maxEventSize: Number.POSITIVE_INFINITY`) and cleanup joins foreign finalizers; the live tier cannot settle either claim, so both stay disclaimed rather than asserted                                                                                                                                                                                                                                                                                                                                                                                                          |
| The kernel tiers are synthetic by construction  | `src/test-kernel/llm/` is ~9.7k lines of fixture suites: they pin lowering, decoding, ordering and every explicit failure, and they stay hermetic and free. Wire behaviour is `test-live/`'s subject, not theirs                                                                                                                                                                                                                                                                                                                                                                                                             |

## 3. Changes

1. **A live tier — landed (#12919).** One `*.live.ts` suite per HTTP protocol,
   eleven of the twelve, key-gated by environment. `vscode-lm` is acquired
   through the extension host's `vscode.lm` API
   (`packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts`), so
   its live check runs in an Extension Development Host job, not in the
   package's Vitest project. The matrix follows each protocol's advertised
   capabilities: a text turn, a tool call round trip, an abort mid-stream and
   the usage shape everywhere; a successful continuation only where the codec
   supports it, and the explicit unsupported failure where it does not (the
   OpenAI Chat codec rejects `turn.continuation` by contract). Runs in CI only
   on a labelled job with secrets; runs locally when keys exist.
2. **Restore hosted tools or decide explicitly — open.** Either implement
   `web_search` on Responses and search/fetch on Anthropic inside the codecs,
   with their usage accounting, or record in the rulings ledger that 1.0
   ships without them and remove the dead enum arms. Do not leave the
   explicit failure as the resting state.
3. **Split the oversized sources — landed (2026-09-21).** Along the study's
   lines: `turn.ts` over `protocol.ts`, `message.ts`, `errors.ts` and
   `transport.ts`, with the request, configuration, result and event contract
   staying in `turn.ts`; the two protocol entries that were over the bound
   (`openaiResponses.ts`, `openaiChat.ts`) split the same way, each new module
   importing the file that defines a symbol rather than its own entry.
4. **Make the boundary real — landed (#12915).** The `@llm/*` alias is gone
   from `tsconfig.json`: `scripts/aliasUtils.mjs` expands every tsconfig alias
   to an absolute filesystem path, so an `exports` map is never consulted
   while the alias exists. Callers import `@texra-ai/llm/<subpath>` through
   the workspace package instead. The root export the 2026-09-06 study named
   is still not part of this: `packages/llm/src` has no root module, no caller
   imports the bare specifier, and a barrel written to carry one is the
   convenience barrel CLAUDE.md forbids.
5. **Rewrite the README against the tree — landed (2026-09-21).** It describes
   the modules, the two test tiers and the caveats that remain. The two 09-06
   docs moved to `implemented/` when this note was written.

## 4. Acceptance

- `packages/llm` has a `live` Vitest project with one suite per HTTP
  protocol; `vscode-lm` has a live check in the extension-host job. **Met.**
- No `unsupported hosted` failure path remains, or a ruling names it. **Open**
  — change 2.
- No file in `packages/llm/src` exceeds 1 500 lines. **Met** (largest: 1 413).
- No `@llm/*` alias in `tsconfig.json`; every consumer imports
  `@texra-ai/llm/<subpath>` and the resolver enforces the `exports` map.
  **Met.**

## 5. What is still open

**Hosted tools (change 2), and nothing else.** `anthropicMessages.ts:680`
still answers a hosted-tool result with an explicit failure, and the OpenAI
Responses side has no `web_search`. Two ways to close it, both of which this
note asked for and neither of which has been taken:

1. Implement them in the codecs, accounting their usage like every other
   provider-side tool, and cover the round trip in the live tier.
2. Record a ruling that 1.0 ships without hosted tools, and delete the dead
   arms (`anthropicMessages.ts:680` and `:708`) so the codecs stop advertising
   a capability they refuse.

The recommendation on file is the second: it is deletion-shaped, it removes an
explicit failure path from the codecs' resting state, and the capability can
return with the accounting it needs. It is a capability decision, so it is the
owner's to make; nothing else in this note depends on it.

The §2 caveats stay deliberate and are not open work: unsupported content
fails explicitly, the two performance claims stay unclaimed, and the kernel
tiers stay hermetic by design.
