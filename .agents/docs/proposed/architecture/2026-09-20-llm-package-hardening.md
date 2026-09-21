---
created: 2026-09-20
status: proposed
---

# LLM package hardening: migrated, not yet trustworthy

Baseline: `main` at `3378a967`. Parent survey:
[post-refactor architecture survey](./2026-09-20-post-refactor-architecture-survey.md).
Follows the 2026-09-06 [package study](../../implemented/architecture/2026-09-06-llm-package-architecture-study.md)
and [runtime contract](../../implemented/architecture/2026-09-06-llm-runtime-contract.md), both of which are
substantially executed and moved to `implemented/` with this note.

## 1. What is done

`packages/llm` is a pure workspace package (10 files, about 10.5k lines): zero
`platform()`, zero `Effect.run*`, zero `AbortController`; dependencies are the
provider SDKs and `effect`/`zod` only. The `Model` contract is
`prepareTurn`, then `streamTurn` or `generateTurn`, where `generateTurn` is a
fold over the stream so the two cannot diverge. Twelve protocols through six
factories plus the VS Code language-model host. Retry and pricing sit in the
runtime. The model-handler hierarchy has zero references (#12320); every
route, helper, tool-use and reflection call goes through `ModelInvoker`.

## 2. What is not

| Gap                                          | Evidence                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero live-provider tests across 12 protocols | ~9.7k lines of synthetic-transport fixtures in `src/test-kernel/llm/`; the README disclaims MiniMax parity and bounded stream memory                                                                                                                       |
| Hosted tools regressed                       | OpenAI web search and Anthropic search and fetch worked on the old handlers; the codecs now fail explicitly (`anthropicMessages.ts` "hosted-tool accounting is not supported"). The 2026-09-07 comparison required closing this before retiring the routes |
| `turn.ts` at 2 063 lines                     | holds the protocol enum, messages, request, configuration, result, errors, SSE, stream pull, tool-arg parsing, the abort-safe request helper and the `Model` interface; the study's `model.ts`/`message.ts`/`errors.ts` split never happened               |
| The package boundary is nominal              | all 46 import sites use the `@llm/*` tsconfig alias, bypassing `exports`; four modules are cross-imported yet unexported                                                                                                                                   |
| Unimplemented and documented as such         | assistant media output, Responses service-tier billing, native provider compaction, OpenRouter continuation and estimate                                                                                                                                   |
| Stale README                                 | still says configured routes use the old model system, eight days after deletion                                                                                                                                                                           |

## 3. Changes

1. **A live tier.** One `it.live` suite per HTTP protocol, eleven of the
   twelve, key-gated by environment. `vscode-lm` is acquired through the
   extension host's `vscode.lm` API
   (`packages/extension/src/frontend/lm/acquireVscodeLanguageModel.ts`), so
   its live check runs in an Extension Development Host job, not in the
   package's Vitest project. The matrix follows each protocol's advertised capabilities:
   a text turn, a tool call round trip, an abort mid-stream and the usage
   shape everywhere; a successful continuation only where the codec
   supports it, and the explicit unsupported failure where it does not
   (the OpenAI Chat codec rejects `turn.continuation` by contract). Runs in CI only on a
   labelled job with secrets; runs locally when keys exist. This is the only
   wire evidence the package will have.
2. **Restore hosted tools or decide explicitly.** Either implement
   `web_search` on Responses and search/fetch on Anthropic inside the codecs,
   with their usage accounting, or record in the rulings ledger that 1.0
   ships without them and remove the dead enum arms. Do not leave the
   explicit failure as the resting state.
3. **Split `turn.ts`** along the study's lines: `protocol.ts`, `message.ts`,
   `turn.ts` (request, configuration, result), `errors.ts`, `transport.ts`
   (SSE, pull, the request helper). Mechanical; #12842 and #12874 already
   started it.
4. **Make the boundary real.** Delete the `@llm/*` alias from
   `tsconfig.json`: `scripts/aliasUtils.mjs` expands every tsconfig alias to
   an absolute filesystem path, so an `exports` map is never consulted while
   the alias exists. Callers import `@texra-ai/llm/<subpath>` through the
   workspace package instead, and export the four cross-imported modules or
   inline them. The root export the 2026-09-06 study named is not part of
   this: `packages/llm/src` has no root module, no caller imports the bare
   specifier, and a barrel written to carry one is the convenience barrel
   CLAUDE.md forbids.
5. Rewrite the README against the tree; move the two 09-06 docs to
   `implemented/`.

## 4. Acceptance

- `packages/llm` has a `live` Vitest project with one suite per HTTP
  protocol; `vscode-lm` has a live check in the extension-host job.
- No `unsupported hosted` failure path remains, or a ruling names it.
- No file in `packages/llm/src` exceeds 1 500 lines.
- No `@llm/*` alias in `tsconfig.json`; every consumer imports
  `@texra-ai/llm/<subpath>` and the resolver enforces the `exports` map.
