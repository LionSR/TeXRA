# The llm provider wire layer: what the audit landed, gated and refused

Date: 2026-11-16
Status: proposed (gated items), with the cheap items landed in the PR that
adds this note.

Origin: a scheduled structural-debt audit of `packages/llm/src/api` (the three
provider interaction/streaming adapters — Anthropic, the OpenAI Responses
cluster, Google — and the shared turn/message/transport/errors layer), hunting
for duplicate logic, inconsistent patterns, over-complex functions and repeated
workarounds. Checked against `main` at `860a621`.

## The theme that landed

A handful of provider-wire boundary facts were each restated once per adapter.
The PR that adds this note gives each one owner:

1. **The Files-API upload decode** was written as a named const twice
   (`anthropicMessages.ts`, `openaiResponsesWire.ts`), byte-identical apart
   from the expiry field schema and its conversion to epoch milliseconds. Now a
   `uploadedFileSchema(expiresAt, toMs)` constructor beside `UploadedSchema` in
   `uploadCache.ts`.
2. **The ambient `*_CUSTOM_HEADERS` refusal** was a shared Effect in the
   OpenAI-named `openaiResponsesRequest.ts` plus a hand-inlined copy in
   `anthropicMessages.ts`. Now `refuseAmbientHeaders(envVar, message)` in the
   provider-neutral `transport.ts`.
3. **The SDK HTTP-fact extraction** ternary was byte-identical in
   `anthropicMessages.ts` and the one-function `openaiError.ts`. Now
   `sdkHttpFailure(cause, apiError, apiConnectionError)` in `errors.ts` (SDK
   classes passed in, so `errors.ts` imports no provider SDK); `openaiError.ts`
   deleted and `openaiFailure` moved beside the OpenAI codec.
4. **The accepted-remote-operation construction** was the same
   `decodeUnknownSync(RemoteOperationSchema)` at the OpenAI and Google submit
   sites. Now a `remoteOperation(origin, providerResponseId)` builder in
   `errors.ts`.
5. **Google's continuation attach** re-decoded the whole turn through
   `TurnResultSchema` only to narrow a loosely-typed continuation; the OpenAI
   path already spreads it raw with a typed continuation. Google now does the
   same, dropping a redundant re-validation of trusted in-process data.

## Gated: OpenAI background submit could go non-streaming

`createResponse` always sets `stream: true` and the background submit path then
hand-rolls an `Effect.acquireRelease` async-iterator plus one `iterator.next()`
to read the acceptance event, carrying a subtle close-then-abort-on-success
finalizer ordering (`openaiResponses.ts`, the `submit` of `backgroundLifecycle`).
Google's background submit already does the simple thing: `stream: false`, a
plain promise, no iterator (`googleInteractions.ts`). Converging OpenAI onto a
non-streaming background create would delete the whole iterator block (~20
lines) and the ordering invariant, and end the OpenAI/Google background dual.

Why it is gated, not landed: it is a deliberate **wire-behavior change**, not a
pure refactor. It must first be confirmed (against the live OpenAI Responses
API or the installed SDK) that a background create with `stream: false` returns
a `Response` the existing `ResponseEventSchema`/`terminalParts` decoder can read
for acceptance (id/model/status). If it does not, detached submissions silently
break or lose their response id and can never be observed or cancelled. This is
the owner's call; land it as its own commit under a "Needs your eye" line once
confirmed.

The refuted alternative — routing the submit through `sdkStream |> take(1)` —
would flip the deliberate finalizer ordering and need a banned ordering knob, so
it is not pursued.

## Refused: do not converge these behind a port, adapter or helper

The audit verified these as net losses against the hard-won lesson (adding a
seam to unify is a loss when the duplicated surface is smaller than the seam).
Do not re-propose as originally specified:

- **The three provider model entries and the two `filesApiUploads` call sites**
  behind a typed SDK-client/entry port. Each entry's SDK client, auth wrapper
  and headers are genuinely distinct; `filesApiUploads` already is the shared
  deep module, with `FilesApi` keeping the per-SDK create/remove/parseUploaded
  at each binding. A port plus per-provider adapters is larger than what it
  replaces and deletes no named symbol.
- **The session-token retry pair.** The authorized path re-runs the same Effect
  on a fresh token; the WebSocket path reopens and resends on a fresh
  connection (`ScopedRef.set`). Not one operation.
- **The three history-lowering evidence guards.** Each carries provider-specific
  constraints and its own diagnostic message that a hoisted guard would strip.

## Why the rest of the area is healthy

The turn assembly is already one deep module (`assembleTurn.ts`/`parts.ts`) fed
by every provider through a common `PartEvent` protocol; `sdkModelError` already
owns SDK-failure classification; `FILE_UPLOAD_LIFETIME_SECONDS`,
`UploadedSchema` and `RemoteOperationSchema` are already single-sourced. The
items above are the whole of what a sweep of this area turns up.
