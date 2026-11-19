# OpenAI background windows, cache lifetime and WebSocket warmup

Date: 2026-11-18
Status: proposed

Origin: the review of what the provider SDKs added since TeXRA last adopted
their features (openai 7.40–7.59). Three of the additions are a choice
between cost and latency. TeXRA adds no setting for a special case, so each
one waits until a fact the code already holds can decide it. This note
records what each needs.

## 1. Discounted background windows

`background_options: { completion_window: '2h' | '8h' }` (openai 7.58, beside
`background: true`) runs a background response 30% (2h) or 40% (8h) below the
Standard rate. It needs Standard processing and a non-streamed request.

Today the mode is a capability, not a choice: `ModelInvoker` runs every turn
in background mode when the bound model has a `background` member
(`packages/harness/src/agent/runtime/ModelInvoker.ts`, `mode` near
`bound.model.background`), and the background lifecycle submits and then
observes the stream (`packages/llm/src/api/background.ts`). A window of hours
would delay every interactive turn, so it can never be the default.

The fact that could decide it is whether anyone waits on the turn. Nothing
records that today: a background script run
(`packages/harness/src/shared/schemas/agentConfig.ts`, `script.kind`
`background`) asks no model itself, and the child runs its `agent` calls start
are awaited by the script. A run kind with no waiting reader (a scheduled or
overnight batch) would have to exist first. Open questions before
implementing:

- Observing a windowed response: the window requires `stream: false`, so
  `observe` would poll `responses.retrieve` instead of streaming. That is a
  second observation path in `background.ts`.
- Resume after restart already works from the stored response id; check that
  a response queued for hours is still retrievable under the account's
  retention.
- The run's attention line and cost should show that a turn is queued and
  discounted (llm-zoo has no window discount; it would need a field).

## 2. Cache write lifetime

GPT-6.x models bill cache writes: 1.25x input for 30-minute retention and
2.5x for 12 hours (OpenAI pricing page, 2026-11-18). The request chooses the
minimum lifetime with `prompt_cache_options.ttl` (`'30m' | '12h'`, openai
7.50); TeXRA sends none. `prompt_cache_retention`, now deprecated in favour of
that field, needs nothing: current models accept only `24h`.

A 12-hour write pays off only when the same prefix is read again after 30
minutes, for example a project session resumed later the same day. The fact
that could decide it is the gap between a run's turns, which the run history
holds; nothing reads it for this today. Until a measurement shows long gaps
are common, keep the default.

## 3. WebSocket warmup

`response.create` with `generate: false` (openai 7.47) fills the prompt cache
on a Responses WebSocket without producing output. It helps only when a
connection is opened before the turn that needs it. TeXRA opens the
connection on a turn's first use (`packages/llm/src/api/openaiResponsesWebSocket.ts`),
so there is nothing to warm. Revisit if a host starts opening connections
ahead of a turn (for example while the user types).
