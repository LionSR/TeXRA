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
`08ee302ea6`. All five changes below are closed: four by landing, and the
fifth — hosted tools — by ruling rather than implementation.

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
- **Change 2, hosted tools — closed by ruling (2026-09-22).** The decision is
  the note's second option: 1.0 ships without provider-hosted tools, the local
  `web_search` and `web_fetch` tools are the one system for web search and
  fetch, and the dead accounting arms are deleted. The ruling, its evidence
  and its forbids live in the
  [rulings ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md);
  see [§5](#5-how-change-2-closed) for how it closed.

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

| Gap                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted tools regressed                          | Closed by ruling (2026-09-22, the rulings ledger): 1.0 ships without provider-hosted tools — the local `web_search` and `web_fetch` tools are the one system for web search and fetch. The two dead accounting arms in the Anthropic codec are deleted, so the codecs stop advertising a capability they refuse; hosted blocks still fail the event schema as malformed output, and the `pause_turn` arm keeps naming the boundary a future lane would have to implement |
| Unimplemented, and documented as such           | assistant media output, Responses service-tier billing accounting, native provider compaction, OpenRouter continuation and token estimation                                                                                                                                                                                                                                                                                                                              |
| No bounded-memory or bounded-stop-latency claim | the SSE parser's event-size cap is disabled (`maxEventSize: Number.POSITIVE_INFINITY`) and cleanup joins foreign finalizers; the live tier cannot settle either claim, so both stay disclaimed rather than asserted                                                                                                                                                                                                                                                      |
| The kernel tiers are synthetic by construction  | `src/test-kernel/llm/` is ~9.7k lines of fixture suites: they pin lowering, decoding, ordering and every explicit failure, and they stay hermetic and free. Wire behaviour is `test-live/`'s subject, not theirs                                                                                                                                                                                                                                                         |

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
2. **Hosted tools — closed by ruling (2026-09-22).** The second of the two
   options this change named is the one taken: the rulings ledger records
   that 1.0 ships without provider-hosted tools (the local `web_search` and
   `web_fetch` tools are the one system for web search and fetch), and the
   dead accounting arms are deleted, so the codecs stop advertising a
   capability they refuse. Hosted blocks still fail the event schema as
   malformed output, `pause_turn` keeps naming the continuation seam, and a
   future lane must bring the usage accounting and that continuation protocol
   together. See [§5](#5-how-change-2-closed).
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
- No `unsupported hosted` failure path remains, or a ruling names it. **Met
  by ruling** — the ledger's 2026-09-22 entry names it: 1.0 ships without
  provider-hosted tools, the dead accounting arms are deleted, and the
  `pause_turn` arm stays the explicitly named boundary.
- No file in `packages/llm/src` exceeds 1 500 lines. **Met** (largest: 1 413).
- No `@llm/*` alias in `tsconfig.json`; every consumer imports
  `@texra-ai/llm/<subpath>` and the resolver enforces the `exports` map.
  **Met.**

## 5. How change 2 closed

**By ruling, on 2026-09-22 — nothing in this note is open any more.** The
ruling
([rulings ledger](../../implemented/architecture/2026-08-01-architecture-rulings-ledger.md))
takes this note's on-file recommendation, its option 2: 1.0 ships without
provider-hosted tools, because the run's local `web_search` and `web_fetch`
tools already are the one system for web search and fetch and a hosted
execution of the same capability would be a second system. The two dead
accounting arms are deleted from the Anthropic codec; a stream that carries
hosted execution still fails loudly (the hosted blocks fail the event schema
as malformed output), and the `pause_turn` arm keeps naming the boundary.

A bare codec restore was refused on one further ground the ruling records:
Anthropic pauses hosted execution on large result sets, so `web_search`
without a continuation protocol breaks in practice, and that continuation is
a runtime-loop seam, not a codec patch. The next lane's spec, if one opens,
is both halves together: usage accounting folded through `providerUsage` and
the `pause_turn` continuation protocol.

The §2 caveats stay deliberate and are not open work: unsupported content
fails explicitly, the two performance claims stay unclaimed, and the kernel
tiers stay hermetic by design.
