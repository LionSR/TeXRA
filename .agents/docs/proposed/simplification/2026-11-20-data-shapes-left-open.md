# Data shapes the 2026-11-20 audit verified and did not land

Date: 2026-11-20
Status: proposed
Origin: the 2026-11-20 scheduled data-structure audit, read on `main` at
`f38bb2a`. Its PR landed seven shapes where one state was spelled as a
flag beside optionals, or a fact was stored twice: the run listing's
continuation, a transcript stage's end, the compaction block's unread
finish time, the CLI's quiet flag, the upload cache's claim set, a plugin
card's setup and a control follow-up's placeholder message. The findings
below were checked against their producers and readers and held back, each
for the reason given, in the order worth taking.

## 1. The `approve` decision carries fields of two request kinds

`RequestDecisionSchema` (`packages/harness/src/shared/schemas/request.ts`)
gives its `approve` case the proposal's edits (`model`, `agent`,
`instruction`, `inputFiles`, `contextFiles`, `mediaFiles`) and the tool
edit's `content`, and `REQUEST_ANSWERS` lets `toolEdit`, `bash`,
`proposal` and `planApproval` all answer with it, so a bash approval
type-checks with file lists. Readers probe with `'model' in decision`
(`packages/texra/src/shared/session/surfaceDecision.ts`), and
`traceAssembler.ts` strips `content` by hand.

Proposed: a plain `{ action: 'approve' }` plus a kind-specific `edit`
union (`{ kind: 'proposal', … } | { kind: 'toolEdit', content }`), or
separate answers in `REQUEST_ANSWERS` for `proposal` and `toolEdit`.

Held back: it changes `request.decided` (a row version bump) and the
decision every host posts from its approval panels; about a dozen
producers across the harness, the app's proposal editor and the tool-edit
controller. Its own PR, with the approval suites as the check.

## 2. A launch's fresh-or-resume case is four optional fields

`ExecuteAgentOptions` (`packages/harness/src/agent/runtime/executeAgent.ts`)
says "fresh" by `registration` being present and carries `parentId` only
for a resume; the `LaunchEntry` in `run/AgentRun.ts` repeats
`registration: Registration | null` beside a `seed` copied from it,
optional and nullable at once. `requests.ts` reads
`entry.registration?.start ?? null` though `enterRun` already refuses a
registration whose `start` is null.

Proposed: `start: { kind: 'fresh'; registration } | { kind: 'resume';
parentId }` on the options, and one `fresh: { registration; seed } | null`
on the entry.

Held back: not persisted, but it reshapes the one run program's entry
(three launchers, `runLoop.ts`, `requests.ts`); worth doing beside the
next change to `executeAgent`, not as a drive-by.

## 3. The `rpc` message is an untyped field in four schemas, cast at ten sites

`SessionEnvelopeSchema.message`
(`packages/texra/src/shared/session/sessionFrames.ts`) and the desktop
prompt's `RpcMessageSchema` (`packages/desktop/src/shared/desktopPromptMessages.ts`)
are `Record<string, unknown>`; `HostAttachFrameSchema`
(`packages/texra/src/controllers/server/hostCalls.ts`) and `host.answer`
(`protocol.ts`) are `Schema.Json`. Every producer holds a typed
`RpcMessage` and casts it down, every reader casts it back
(`windowHost.ts`, `hostWindows.ts`, `SessionBridge.ts`,
`sessionTransport.ts`, `desktopPromptController.ts`,
`promptOverlay.ts`, the desktop renderer's `main.ts`, the trace viewer's
bridge). `SessionWire` restates the envelope as a hand-written interface.

Proposed: one schema per direction, declared once, whose decoded type is
`RpcMessage.FromClientEncoded` or `FromServerEncoded`, used by all four
carriers, with `SessionWire` derived from the envelope schema.

Held back: two of the carriers ride an Effect RPC over the service socket,
whose serialization needs a JSON codec for the field; a `Schema.declare`
needs that annotation, and the right encoded form (`Json` vs `Record`)
should be decided once for all four. Check `RpcSerialization` first.

## 4. The desktop `WorkbenchTab` is a union written as optionals

`WorkbenchTab` (`packages/desktop/src/shared/desktopShellState.ts`) has
`target?` (required for editor, pdf and browser tabs, meaningless for the
rest), `build?` (pdf only) and `dirty?` (editor only). `dirty` is held a
third time beside the editor pane's own state and the dock panel's params,
and since the shell state is persisted the restore path resets it.

Proposed: a union on `kind` with `target` and `build` where they belong,
and `dirty` dropped from the persisted state: the tab strip reads the
editor pane's own dirty set.

Held back: the persisted shell state changes (a stored layout from an
earlier build fails its decode unless the workbench drops it), and the
renderer's tab code was reworked in #15026; let it settle first, as the
2026-11-18 note said of the terminal pane.

## 5. Smaller

- `CompactionActivityBlock.finalized`
  (`packages/harness/src/shared/runs/compactionActivityProjection.ts`)
  is derivable from `status` and `finalThroughSeqNo`, and `freed` is valid
  only on `completed`; a status union would hold both. Its unread
  `finishedAt` landed in this PR; the rest changes the public transcript
  type (`transcriptEntry.ts`) for little gain.
- The CLI chat's `slashPaletteOpen` and `reverseSearchOpen`
  (`packages/cli/src/chat/tui/state/cliState.ts`) are never both true, and
  every layout reader ORs them. One `inputOverlay` field would need the
  palette's effect to leave a reverse search alone on cleanup (today it
  writes `false` to its own field only), so the merge adds an ordering rule
  rather than removing one. Not worth it unless the input bar is reworked.
- The CLI history delete result's `found`
  (`packages/cli/src/runtime/history.ts`) repeats `status !== 'not-found'`
  and has no code reader; it is in the `--output-format json` output, so
  dropping it is a CLI contract change.
