# The largest design problems: what the 2026-11-27 evening sweep left open

Date: 2026-11-27
Status: proposed
Origin: the scheduled evening sweep on `main` at `6e86ac8f7b`. This part
covered the app's service layer (`packages/texra/src/controllers/server/`)
and its readers in the CLI. The branch that adds this note gives each of
these facts one owner: the service handlers' lease of a project's session
(`over` in `service.ts`), the wording of the service's bridge errors
(`requestOnService`), the wording of a failed stop (`stopService`), the
wait on the link's one state (`serviceSession`), and the chat's root-launch
claim (`claimRootLaunch` in `chatSessionController.ts`).

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
