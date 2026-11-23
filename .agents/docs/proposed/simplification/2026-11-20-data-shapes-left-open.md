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

Findings 1 (the `approve` decision carrying two request kinds' fields)
and 2 (a launch's fresh-or-resume case as four optionals) landed in the
2026-11-21 data-structure audit: an approval's changes are one `edit`
union named by its request kind (`request.decided` v5), and a launch takes
one `entry` union and its run entry one `fresh` field. The rest stay open.

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

Landed 2026-11-22: `RpcClientMessageSchema` and `RpcServerMessageSchema`
(`packages/texra/src/shared/rpcOverMessages.ts`) refine `Schema.Unknown` to
`rpc`'s encoded types, which `Schema.toCodecJson` passes through, so the
socket carriers need no declared codec. The session envelope is
`ClientEnvelopeSchema` and `ServerEnvelopeSchema`, `SessionWire` their union,
and the eleven casts are gone.

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

Landed 2026-11-22: `dirty` is gone from the tab and the dock panel's
parameters; the dock asks the editor pane (`PaneKind.isDirty`) and an edit
only redraws the tab. A stored tab that still carries `dirty` decodes, since
structs ignore undeclared keys. The union on `kind` stays open: every pane
handler takes the whole `WorkbenchTab` through `panes[tab.kind]`, so
per-kind members would trade the `target` checks for correlated casts
there; take it with a typed pane table.

## 5. Smaller

- `CompactionActivityBlock.finalized`
  (`packages/harness/src/shared/runs/compactionActivityProjection.ts`)
  is derivable from `status` and `finalThroughSeqNo`, and `freed` is valid
  only on `completed`; a status union would hold both. Its unread
  `finishedAt` landed in this PR; the rest changes the public transcript
  type (`transcriptEntry.ts`) for little gain.
  Landed 2026-11-23: the block is a union on `status` (`interrupted`
  carries `finalThroughSeqNo`, `completed` its `freed` and `replaced`),
  and `isCompactionActivityFinal` reads finality where `finalized` was
  read.
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
  Landed 2026-11-23: `found` is gone; the JSON output states `status`
  alone.

## 6. Landed beside them, 2026-11-23

The 2026-11-23 data-structure sweep took §5's first and last items and
four more of the same kind:

- `ToolRowModel.isUserFeedback` and `NormalizedToolUse.isUserFeedback`
  restated whether the call has a user instruction; readers ask
  `userInstruction`.
- A stored `userQuestion` request kept the model's nulls (a question's
  `header`, an option's `description`, the request's `context`) and left
  `multiSelect` and `allowFreeText` absent, null or a boolean. The tool
  keeps the nullable input and stores absent fields and two booleans
  (`request.opened` v3).
- A `max_tokens_reduced` event's `tokensBefore` and the context-management
  row's `data` had no reader.
- The CLI's ambient `termIsDumb` was optional though always set.

Still open, each for the reason given:

- `WorkbenchTab`'s union on `kind` (§4): needs the typed pane table, and
  its readers are the desktop renderer's.
- `slashPaletteOpen` / `reverseSearchOpen` (§5): terminal UI state, for an
  input-bar rework.
- `ExecResult.success` (`packages/harness/src/utils/system/execUtils.ts`)
  is `end._tag === 'Exited' && end.code === 0` stated beside `end`. It is
  on the `./node` surface with about twenty readers across the hosts; a
  predicate over `end` would replace it, for no fewer lines.
- `ToolFileAttachment`'s three payload fields and the LaTeX settings
  status stay with the decisions the 2026-11-18 and 2026-11-15 notes name.
