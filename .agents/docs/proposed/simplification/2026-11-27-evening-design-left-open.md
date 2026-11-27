# The largest design problems: what the 2026-11-27 evening sweep left open

Date: 2026-11-27
Status: proposed
Origin: the scheduled evening sweep on `main` at `6e86ac8f7b`, in three
parts: the harness run loop, the app's service layer
(`packages/texra/src/controllers/server/`) and its readers in the CLI, and
the llm protocol codecs. The run-loop part landed everything it found and
leaves nothing here. The service-layer part gives each of these facts one
owner: the service handlers' lease of a project's session (`over` in
`service.ts`), the wording of the service's bridge errors
(`requestOnService`), the wording of a failed stop (`stopService`), the wait
on the link's one state (`serviceSession`), and the chat's root-launch claim
(`claimRootLaunch` in `chatSessionController.ts`).

## Service layer

1. **The window session follows its link in two ways.** `serviceSession`
   (`packages/texra/src/controllers/server/serviceSession.ts`) reads its own
   view through `remoteSessionView`, whose source reads `link.client.get`
   once. A forked loop over `link.client.changes` calls `window.set([])`, so
   the view asks the next service again. `watch` follows the same link with
   `Stream.switchMap` and a cursor `Ref`. The two cannot share one follower:
   on every new read, `SessionViewService` re-reads each transcript from the
   seq the view has applied (`view.transcriptSeq`). A follower inside the
   read would re-ask from the aggregates' first `fromSeq`.
   That same fact is an open question about `watch`: after a reconnect it
   asks the new service for `set` from its original `fromSeq` and the latest
   frame cursor, so a transcript the watch had already carried can arrive
   again. Check whether `replayTrace`'s reader drops rows it has seen (by
   seq) before changing anything. Risk: medium. A reconnect path has no
   suite of its own.
2. **`texra service restart` asks for the hello twice.** `ensureService`
   reads the started service's `ServiceInfo` to connect, and the command then
   asks `service.hello` again through the link's client, because
   `ServiceLink` does not carry the info
   (`packages/cli/src/commands/service.ts`). Carrying the info on the
   link's `Linked` state would remove that extra call. It would add a field
   to every link, the local one included, for one reader. Left as it is.
3. **`ConnectService` wraps the client in an object.** `followAttachedTask`
   (`packages/cli/src/chat/tui/state/attachedTask.ts`) takes
   `Pick<ServiceConnection, 'client'>`, which `runChatTui.tsx` builds from
   `linkedClient`. Taking the client itself would let `ServiceConnection`
   stay file-local in `client.ts`. Both files are in the terminal UI, so a
   UI sweep should take it.

## llm protocol codecs

The question was what each protocol codec (`packages/llm/src/api/`) writes
for itself that the shared turn layer should own. The PR that adds this
section lands the instances that hold up: the stream event types read from
the event union (`Schema.toTaggedUnion`, `decodeStreamEvent` in
`transport.ts`), one rule for which turn the next request can extend
(`anchorResponseId` in `continuation.ts`), the upload cache serving file ids
already bound to one clock reading (`fileIds` in `uploadCache.ts`), and two
branches no input reached.

Checked and already owned once, so nothing to move: tool-call argument
assembly from streamed deltas (`assembleTurn.ts` and `parts.ts`), the
retry-after and `x-should-retry` reading (`sdkModelError` in `errors.ts`),
the SDK HTTP facts (`sdkHttpFailure`), the stop and overflow verdicts
(`verdict.ts`). The usage receipts and finish tables differ by wire: the
Anthropic counters are summed, the Responses and Google ones are read as
given, and each protocol names its own stop reasons.

### Open: one owner for "the failure names the requested model"

Every failure a binding raises names its model, the returned one when the
response said, else the requested one. The fallback to the requested model
is written seven times: the outer `fillModelError` of `streamTurn` in
`googleInteractions.ts`, `anthropicMessages.ts` and `openaiResponses.ts`; the
Files request of the Anthropic and Responses bindings; the `enrich` of
`turnAssembly` (`turn.model ?? options.origin.requestedModel`); the `filled`
of `backgroundLifecycle`; and the WebSocket turn's `enrich`. Two places get
no fallback at all: a failure of `prepareTurn`, and a WebSocket handshake
the server refuses (`connect` runs outside the turn's `enrich`).

Proposal: `judgedModel` (`packages/llm/src/api/verdict.ts`), the one wrapper
`bindModel` puts on every binding, fills `model: origin.requestedModel` on
every failure before judging it, and the seven fallbacks go, leaving each
inner scope to fill only the returned model it learned.

Risk: a failure of `prepareTurn`, a refused handshake and an invalid upload
start to carry `model`, a field the run's `failed` row stores. `judgedModel`
takes the origin, so `packages/llm/test/llm/GoogleInteractions.vitest.ts`,
which calls it, changes in the same commit.

### Open: a whole snapshot is assembled through a one-batch stream

Google's completed snapshot (`completedSnapshot`) and a Responses background
submission that finished at once both build `Stream.make(batch)`, run it
through `assembleTurn` and fold it back with `completedTurn` to get the turn
they already hold the parts of. `turnAssembly` can take the parts and
`complete` directly. Two callers and about zero net lines, so it waits for a
third reader of a whole snapshot.
