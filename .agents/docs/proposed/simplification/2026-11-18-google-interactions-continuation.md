# Google Interactions: a turn stopped at the decode limit

Date: 2026-11-18
Status: proposed, held for one decision

## The problem

The Gemini Interactions API can end a streamed interaction with status
`requires_continuation` and a `continuation_token`: the response reached the
per-request decode limit and needs at least one more request to finish. The
Google route (`packages/llm/src/api/googleInteractions.ts`) sends
`automatic_continuation: false`, so a turn owns exactly one request, and
until now such a turn failed as "ended without an authoritative completed
turn" with `retryable: true`. `ModelInvoker` then resent the whole turn,
which re-billed the prompt and stopped at the same limit again.

The first step, landed beside this note: the route fails that turn with its
own message and `retryable: false`.

What `@google/genai` 3.6.0 and the API reference say about continuing
(`AutomaticContinuationOption` in the SDK's `genai.d.ts`; the reference at
aistudio.google.com/api-reference/interactions-api, read 2026-11-18):

- Each hop is its own interaction with its own id, holding only that hop's
  output. With `store: true` the next hop sends the token with
  `previous_interaction_id` set to the hop that issued it and no `input`;
  with `store: false` it resends the original `input` with the token.
- Every hop re-prefills the conversation and the generated prefix, so input
  tokens are billed on every hop. The SDK sums usage across hops; a hop's
  own `usage` covers that hop alone.
- The final hop's id is the one to chain the next turn on.

## The two designs

1. **Continue inside the Google call.** The route opens the next hop itself
   and joins the hops into one turn: an index offset per hop (each hop's
   steps likely restart at 0), one identity (the final hop's id), usage
   summed across hops, and a text or thought step split across the hop
   boundary joined. One owner (the route) and no harness change, but each
   hop is a billed request no `model.message attempt` row precedes, against
   the run loop's write-point contract (`packages/harness/AGENTS.md`, "Run
   loop architecture"), and a failure after a hop loses billed output.
2. **A typed outcome the run loop continues.** The turn ends with a new
   finish (partial content plus the token); `ModelInvoker` records it and
   sends the next hop as another attempt of the same invocation, so every
   billed request has its row. This touches the turn contract
   (`TurnResultSchema`, `packages/llm/src/turn.ts`), the request (a token
   input), the invocation rows (`packages/harness/src/shared/session/inFlight.ts`)
   and how partial content of hops joins into one assistant message.

The decision: whether a provider-required follow-up request inside one turn
may bypass the attempt row (design 1), or whether it is an attempt like any
other (design 2). Design 1 is far smaller; design 2 keeps the contract.

Neither should land without a live capture of a `requires_continuation`
stream: whether step indexes restart per hop, whether a step is split across
the boundary, and how often the limit is reached at all for the models we
bind.

## A related finding

`incomplete` ("completed, but contains incomplete results, e.g. hitting
max_tokens") is not in `COMPLETED_STATUSES`
(`packages/llm/src/api/googleInteractionsWire.ts`), so a Gemini turn that
reaches `max_output_tokens` fails instead of ending with `finishReason:
'length'`, as the other protocols' turns do. Mapping it needs the same live
capture, to confirm the stream closes its steps before the terminal event.
