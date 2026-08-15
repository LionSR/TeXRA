---
created: 2026-08-04
updated: 2026-08-13
---

# PRD: xAI Responses API and `previous_response_id` for Grok

**Status:** Draft — **not implementing yet** (design / sequencing only)
**Owner:** TBD
**Date:** 2026-08-04
**Related:**

- xAI docs: [Generate text (Responses preferred)](https://docs.x.ai/developers/model-capabilities/text/generate-text), [Comparison vs Chat Completions](https://docs.x.ai/developers/model-capabilities/text/comparison), [REST inference](https://docs.x.ai/developers/rest-api-reference/inference/chat)
- TeXRA OpenAI Responses proposal: `docs/proposals/2025-06-04-openai-responses-api.md`
- Landed experimental SuperGrok OAuth route (separate concern): `docs/proposals/2026-08-04-xai-grok-oauth-subscription.md`, PR [#9709](https://github.com/LionSR/TeXRA/pull/9709)
- Difficulty notes: session audit 2026-08-04 (`ModelHandlerOpenAIResponse` ~2.9k lines; Codex already multi-backend via capability profiles)

## 1. Summary

xAI’s preferred text API is **`POST /v1/responses`**, not Chat Completions. The main product win for TeXRA is **`previous_response_id`**: multi-turn and tool-use rounds send only new input while the server retains prior turns (default store **30 days**).

Today TeXRA’s xAI path is **`ModelHandlerXAI` → Chat Completions** only: full history every turn, no response-id chain. OpenAI already has a mature Responses handler with `ServerChainState`, invalid-id recovery, store/encrypted-reasoning modes, and a **Codex capability profile** that proves the handler is multi-backend — not OpenAI-company-locked in its core.

This PRD sequences a **setting-gated** migration for direct `api.x.ai` Grok models onto that Responses stack for **client-side TeXRA tools + chaining only**. It explicitly defers xAI server tools, SuperGrok-specific Responses work (orthogonal to OAuth), catalog/pricing cleanups, and Imagine/Voice.

**Do not implement this PRD in the SuperGrok OAuth PR or the TypeScript 7 PR.**

## 2. Goals and non-goals

### Goals (MVP)

1. Direct xAI (not OpenRouter) Grok models can use Responses when enabled.
2. Multi-turn and tool-use follow-ups send **`previous_response_id`** when a chain exists.
3. On invalid/expired id (or chain disabled), **full-history resend** still works (existing invalidate path).
4. **Client function calling** (TeXRA tool registry) works end-to-end on Responses.
5. Streaming works for tool-use agents; background/WebSocket OpenAI features stay **off** for xAI.
6. Prefer switch / API-key / server-key / SuperGrok Bearer auth still work on the same base URL (auth is credential only).
7. Default remains Chat Completions until the flag is on and smoke criteria pass (or until a later “on by default” decision).

### Non-goals (this PRD)

| Out of scope                                                       | Why                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| SuperGrok OAuth product                                            | Landed separately in #9709; Responses only needs its Bearer credential on `api.x.ai` |
| xAI server tools (`web_search`, `x_search`, `code_interpreter`, …) | Product surface + pricing; follow-up                                                 |
| `search_parameters` on Chat Completions                            | Completions-only live search; not required for chaining                              |
| Imagine / Voice / Batch / deferred                                 | Different APIs                                                                       |
| Full catalog (4.20, build-0.1) or long-context pricing accuracy    | llm-zoo / billing follow-up                                                          |
| OpenRouter Responses                                               | OpenRouter stays Chat Completions                                                    |
| Rewriting a second Responses handler from scratch                  | Reuse `ModelHandlerOpenAIResponse` + profile                                         |
| Forcing `store: false` + encrypted thinking as default             | xAI default is store true; encrypted path is fallback research                       |

## 3. Current state (TeXRA)

| Layer                   | Today                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                | `https://api.x.ai/v1`                                                                                                                                                                                      |
| Handler                 | `ModelHandlerXAI` extends chat-completions `ModelHandlerOpenAI`                                                                                                                                            |
| Factory                 | `ModelProvider.XAI` → `ModelHandlerXAI` only                                                                                                                                                               |
| `shouldUseResponsesAPI` | **OpenAI only**                                                                                                                                                                                            |
| Chain                   | None for xAI; OpenAI uses `ServerChainState`                                                                                                                                                               |
| Auth                    | API key / server key / OpenRouter / SuperGrok OAuth Bearer                                                                                                                                                 |
| Catalog                 | llm-zoo 1.27.0: `grok46` (xAI `grok-4.6`), `grok45`, `grok43`, retired older. Not in catalogue: `grok-build-0.1`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning` |

OpenAI Responses already provides:

- `previous_response_id` via `ServerChainState`
- `store` / `storesResponsesServerSide` capability
- Invalid previous-response recovery
- Function tools + tool follow-up message builders
- Client compaction fallback when server store is false
- Codex profile: chaining off, store false, uploads off, background off

## 4. Product decisions

1. **Preferred long-term path for direct xAI is Responses.** Chat Completions remains a supported fallback, not the destination.
2. **MVP is chaining + client tools**, not “full xAI agent API.”
3. **Ship behind a setting first** (mirror `texra.model.useOpenAIResponsesAPI`), default **off**, until soak criteria pass. After soak, flip default **on** in the **next release** (one release behind the flag), not a longer hold: xAI now labels Chat Completions “Deprecated,” so staying on Completions past one soak cycle is the riskier path. The first ship stays default-off so a Responses regression cannot take production Grok traffic without an explicit opt-in.
4. **Default `store: true`** for xAI (docs default). Rely on `previous_response_id` for continuity; do not invent a second history system.
5. **OpenRouter keeps Completions** for xAI models.
6. **Do not enable xAI native server tools in MVP** even if the Responses tools array supports them later.
7. **Keep this work separate from #9709** (OAuth) and #9708 (TypeScript 7). Both have landed; Responses routing belongs in an independent PR.
8. **Naming:** internal types may stay `OpenAIResponse*` historically; product copy says “xAI Responses” / “Grok response chaining.” No user-facing “OpenAI API” label for Grok.

## 5. Proposed design

### 5.1 Routing

```
createModelHandler(config):
  if config.provider === XAI
     && !openRouter
     && useXaiResponsesAPI (setting)
    → ModelHandlerOpenAIResponse  // or thin ModelHandlerXAIResponses subclass
  else if XAI
    → ModelHandlerXAI (chat completions, today)
```

Optional thin subclass responsibilities only:

- `validateReasoningEffort` → `low | medium | high` (+ document `none` for 4.3 if required)
- SuperGrok / subscription credential route (reuse the Bearer route already present in chat `ModelHandlerXAI`)
- Force-disable WebSocket / background regardless of GPT name gates

### 5.2 Capability profile (xAI direct Responses)

Use the existing `openAIResponses` profile knobs (name is historical):

| Flag                                    | xAI MVP                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `supportsResponseChaining`              | `true`                                                   |
| `storesResponsesServerSide`             | `true`                                                   |
| `backgroundMode`                        | `disabled`                                               |
| `streaming`                             | `base` (normal streaming)                                |
| `webSocket`                             | off / never selected for non-OpenAI base URL             |
| `supportsTokenCounting`                 | `false` until `/responses/input_tokens` verified         |
| `supportsManualCompaction`              | `true` only after compact smoke; else client path or off |
| `supportsInlineInputFileUpload`         | `false` until proven                                     |
| `supportsToolResultFileUpload`          | `false` until proven                                     |
| `failWhenFallbackOutputBudgetIsReduced` | start `false`; tighten if needed                         |

### 5.3 Request shape (MVP)

- `model`, `input` (delta when chained), `instructions` when needed
- `previous_response_id` when `ServerChainState` has an anchor
- `store: true`
- `tools` / `tool_choice` for TeXRA client functions only
- `max_output_tokens` (not legacy `max_tokens`)
- Reasoning: map effort without requiring GPT-5 `summary` unless verified safe
- **Do not** set OpenAI-only `service_tier: 'fast'` unless mapped to xAI `priority` in a later stage

### 5.4 Failure modes

| Failure                                  | Behavior                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Invalid / expired `previous_response_id` | Invalidate chain; resend full input; log warn                                           |
| Unknown stream events                    | Prefer existing OpenAI stream hardening; if hard fail, flag-off fallback to Completions |
| OpenRouter on                            | Never Responses for XAI                                                                 |
| Flag off                                 | Completions path unchanged                                                              |

### 5.5 Host / product surface

- Settings: e.g. `texra.model.useXaiResponsesAPI` (or a single “prefer Responses where supported” later — **not** in MVP)
- No new user-facing subscription UI (that product surface landed in #9709)
- Usage route remains `xai` / `xai-subscription` as today; chaining does not change billing product identity

## 6. Implementation stages (when started)

| Stage                              | Work                                                                                                 | Exit criteria                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **0 · Spike**                      | Live `responses.create` against `api.x.ai` with grok-4.5: stream, tools, chain two turns, invalid id | Notes in PR / issue; no product flag required |
| **A · Route + profile**            | Factory + setting + capability profile; no server tools; uploads/WS/background off                   | Typecheck + unit tests for routing            |
| **B · Agent smoke**                | Tool-use agent multi-round; assert second call has `previous_response_id` and reduced input          | Integration or recorded fixture               |
| **C · Reasoning**                  | Effort mapping; reasoning content / encrypted path only if store false ever used                     | Matches Chat Completions quality on 4.5/4.3   |
| **D · Soak**                       | Flag available in nightly / internal; Completions fallback documented                                | Decide default-on                             |
| **E · Follow-ups (separate PRDs)** | Server tools; compact; input_tokens; catalog; pricing; `prompt_cache_key` on both APIs               | Out of MVP                                    |

Stage 0 may kill or shrink the plan if xAI Responses is incompatible with the OpenAI SDK stream types we depend on.

## 7. Difficulty (from code audit)

| Goal                                | Difficulty                                               |
| ----------------------------------- | -------------------------------------------------------- |
| MVP chaining + client tools         | **Medium** (~days of focused work + soak), not a rewrite |
| Full xAI server-tool agent surface  | **High** — separate project                              |
| Greenfield second Responses handler | **Unnecessary** — Codex profile pattern exists           |

**How OpenAI-specific is `ModelHandlerOpenAIResponse`?**

- **Portable:** chain state, create/stream, function tools, store/encrypted gates, invalid-id recovery, much of finalize.
- **OpenAI/GPT product shell (keep off for xAI):** background mode, WebSocket transport, `service_tier: fast`, native `web_search_call` includes, GPT-5 summary knobs, OpenRouter branches, OpenAI Files uploads, uncertain `input_tokens` endpoint.

Core chaining is protocol-shaped. Risk is **live compatibility**, not missing TeXRA chain machinery.

## 8. Acceptance criteria (MVP)

1. With the setting **on**, a multi-turn Grok 4.5 tool-use run on direct xAI sends `previous_response_id` on turn ≥ 2.
2. With the setting **off**, behavior matches today’s Chat Completions path.
3. Invalid previous id does not stuck the session; conversation continues via full resend.
4. No WebSocket or background Responses requests leave the client for xAI.
5. OpenRouter + Grok still uses Completions.
6. The landed SuperGrok OAuth route can authenticate Responses the same as Completions (Bearer on `api.x.ai`).
7. No xAI server-tool types appear in the tools array in MVP.
8. Docs: short note under model/provider docs or proposal cross-link; experimental banner if default remains off.

## 9. Explicit non-consolidation with landed PRs

| Landed PR                                                                   | Relationship                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [#9709](https://github.com/LionSR/TeXRA/pull/9709) Grok OAuth               | **Auth only.** Responses routing remains separate and reuses the landed Bearer path. |
| [#9708](https://github.com/LionSR/TeXRA/pull/9708) TypeScript 7             | **Toolchain only.** No product overlap with Responses routing.                       |
| [#9706](https://github.com/LionSR/TeXRA/pull/9706) Agent SDK readiness docs | **Docs only.** It may be cross-linked but introduces no Responses implementation.    |

See §10 for consolidation advice among current workstreams (not code from this PRD).

## 10. Related consolidation opportunities (current work — not this PRD)

### Why these workstreams remain separate

They have disjoint risk domains: OAuth/secrets, compiler/toolchain, and pure docs. Their landed implementations remain independent of the proposed Responses routing.

### Landed in #9709

- Shared `src/auth/oauth/` (PKCE, loopback, coordinator)
- Shared `subscriptionPreference` / `subscriptionLogin` helpers
- Thin `@auth/xai` vs `@auth/codex` policy adapters

### Residual duals from #9709 (optional follow-up, not a reason to block)

| Dual                                                            | Size            | Worth consolidating?                                                                                              |
| --------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `chatgptAuth.ts` / `grokAuth.ts`                                | ~160 lines each | Maybe later: table-driven provider command if a third subscription appears                                        |
| `chatgptLogin.ts` / `grokLogin.ts`                              | ~90 each        | Mostly thin; shared `subscriptionLogin` already exists                                                            |
| Settings `CodexSubscriptionSection` / `GrokSubscriptionSection` | ~130 each       | **Candidate** shared “SubscriptionProviderSection” with copy/props — only if a third provider lands or diffs hurt |
| `chatGptAuthStatus` / `grokAuthStatus`                          | tiny            | Leave; trivial                                                                                                    |

**Rule:** do not invent a third generic “any OAuth provider” framework for two providers. Consolidate only when the third copy appears or review friction is real.

### Separate small follow-up PRs

1. **llm-zoo / catalog:** grok-4.3 vision flag; setup default `grok45` not retired `grok4`; optional build/4.20 entries.
2. **Pricing fidelity:** cache discount plus model-specific long-context thresholds and rates (or use `cost_in_usd_ticks` when present).
3. **Chat Completions hygiene (pre-Responses):** send `prompt_cache_key` / sticky conv id; prefer `max_completion_tokens` for XAI.
4. **This PRD’s Stage 0 spike** as a throwaway branch or issue notes — no product flag required.

Items 1–3 help Completions **and** make Responses land cleaner; none require waiting on Responses.

## 11. Open questions

1. Default-on timeline after soak — **decided 2026-08-14:** one release behind the flag. Completions is now explicitly deprecated on xAI’s comparison page; a longer hold is not justified once soak criteria pass. First ship remains default-off.
2. Does xAI `/responses/input_tokens` exist and match OpenAI enough to enable token counting?
3. Does xAI `/responses/compact` match our OpenAI compact client path, or client-only compaction forever?
4. Is `reasoning_effort` on Responses for grok-4.5 the same as docs’ “4.3 only” note on Chat Completions?
5. Should encrypted thinking + `store: false` be a privacy mode later, or never for TeXRA agents?

## 12. Success metrics

- Reduced average request input tokens on multi-turn Grok tool-use sessions when flag on (telemetry / debug logs).
- No increase in hard-fail rate vs Completions for the same agents.
- Zero accidental server-tool or WebSocket traffic to xAI in MVP.

## 13. References (code)

- `src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts` — Responses handler
- `src/agent/modelHandlers/support/ServerChainState.ts` — chain anchor
- `src/agent/modelHandlers/openai/modelHandlerXAI.ts` — current Completions + subscription Bearer
- `src/agent/runtime/ModelFactory.ts` — `shouldUseResponsesAPI`
- `src/model/providerCapabilities.ts` — `OpenAIResponseProviderCapabilities` / Codex profile
- `src/agent/modelHandlers/support/ProxyConfigResolver.ts` — `https://api.x.ai/v1`

## 14. Update — 2026-08-12 (re-check against current xAI docs)

Recon pass through the current `docs.x.ai` Pricing, Prompt Caching, and Context
Compaction pages, prompted by a request to check whether TeXRA's Grok
integration needs anything for the current model/pricing lineup. **No code or
catalog changes made — recon only**, per the §2 non-goals.

1. **Chat Completions is now labeled "Deprecated" on xAI's own
   Responses-vs-Completions comparison page**, not merely "not preferred."
   §4.1 already treats Responses as the long-term destination for direct
   xAI; this raises the priority of that call — `ModelHandlerXAI`, TeXRA's
   only xAI path, is Chat-Completions-only today.
2. **The current pricing page adds `grok-4.6`, `grok-build-0.1`, and three
   `grok-4.20-*` variants** (`multi-agent-0309`, `0309-reasoning`,
   `0309-non-reasoning`). TeXRA now uses `llm-zoo` 1.27.0, which already
   contains `grok-4.6`; the other listed IDs remain absent from that catalogue.
   Section 3's older 4.5/4.3 inventory should therefore be refreshed, while
   the remaining IDs require upstream catalogue support before TeXRA can offer
   them.
3. **Long-context pricing is a real, documented xAI mechanic**, not
   speculative: once a prompt's total tokens (cached and non-cached both)
   cross a model's threshold, xAI bills _all_ prompt tokens for that request
   at roughly double the short-context rate. Still unmodeled anywhere in
   TeXRA — `StandardPricingConfig` / `computeStandardPrice`
   (`src/agent/utils/priceUtils.ts`) carries flat input/output rates plus a
   cache discount factor, but no long-context tier; `llm-zoo`'s public schema
   likewise has no long-context tier field (per its npm package description).
   Already flagged as a
   non-goal in §2 ("long-context pricing accuracy | llm-zoo / billing
   follow-up"); still open, now with a concrete billing mechanism to model
   against once a rate source exists.
4. **The endpoint-existence part of §11 open question 3 is answered:
   yes.** `POST /v1/responses/compact` is documented and generally
   available. It takes the same `input` shape as `/v1/responses` and returns
   a `response.compaction` object carrying an opaque `encrypted_content`
   blob to replay verbatim as the head of the next request. Responses-only —
   unreachable from TeXRA until this PRD's routing lands. Whether this endpoint
   is compatible with TeXRA's existing OpenAI compact client path remains open
   and requires a live compatibility check.
5. Prompt-cache accounting itself is already correct at the _rate_ level:
   Chat Completions' `usage.prompt_tokens_details.cached_tokens` is exactly
   what `src/agent/modelHandlers/openai/openAIUsage.ts` already reads for
   every OpenAI-compatible handler, `ModelHandlerXAI` included. The only gap
   is the long-context _tier_ switch in point 3, not cache-token extraction.

Candidate next steps, smallest first: (a) ~~refresh §3 for `grok-4.6` and track
upstream catalogue support for the remaining model IDs~~ (done 2026-08-14;
remaining IDs still wait on llm-zoo), (b) ~~model long-context
tiered pricing in `computeStandardPrice` once a rate source exists~~ (done
2026-08-14: tier tuples wired from xAI's documented per-model rates; llm-zoo
still has no tier field), (c) ~~revisit
this PRD's default-off timeline given Chat Completions' now-explicit deprecated
status~~ (done 2026-08-14: one release behind the flag; see §4 decision 3 and
§11 Q1).
