Read at `cb22acd`. Covered: `packages/cli/src/chat/` (`chatSessionController.ts` and `tui/`: `panes/`, `render/`, `state/`, `modals/`, `forms/`, `input/`, `commands/`, `App.tsx`, `runChatTui.tsx`). Read-only; nothing was built or run, so every behavioral claim below is from reading the source.

### CC-1: One layout `mode` value means both "print everything" and "price the scrollback", so the ring prices rows the terminal never paints

- **Package:** cli
- **Flags:** an option for a special case; special and general code mixed; a false comment; non-obvious code. Remainder of **K11** (round 2, "`transcriptEntryLayout`'s three-valued `mode`"; catalogue row K11 landed #14875 without this item: "D's TUI steps (6.1-6.4) have landed and did not take it").
- **Evidence:**
  - `panes/transcriptEntryLayout.ts:32` `type TranscriptEntryLayoutMode = 'live' | 'scrollback' | 'scrollback-budget'`. `:206` `transcriptRowBodyLines(row, mode !== 'scrollback-budget')` and `:266` `elide: mode !== 'scrollback-budget'`: the budget mode is the only one that does **not** elide. The comment at `:199` calls it "the print-once path ... takes the whole thing".
  - The ring measures with that mode: `panes/staticTranscriptRing.ts:186-190` `transcriptEntryLayout(item.entry, { mode: 'scrollback-budget', ... })`, and `contentRows: Math.max(1, layout.lines.length)` feeds `rowHighWater: 2_000` / `byteHighWater: 1 MiB` (`:66-72`).
  - What `<Static>` paints is the elided form: `panes/TranscriptEntry.tsx:105` `<ToolUseRow toolRow={entry} width={width} />` → `ToolUseRow.tsx:126` `toolUseStyledLines(toolRow, { width })` (elide defaults on: head 6 / tail 3, `render/transcriptRowLines.ts:27-28`), and `:108` `transcriptEntryLayout(entry, { mode: 'scrollback', ... })` for the rest.
  - New since K11: the two disagree by the size of the output. A tool row with a 3,000-line output paints about ten rows and is priced at 3,000, which crosses `rowHighWater`; `trimStaticTranscriptItems` (`staticTranscriptRing.ts:320-362`) then drops the oldest items down to the low-water mark and `advanceScrollback` bumps `origin` (`:690-694`), which clears the terminal and reprints. The same holds for a long `thinking` / `error` body.
  - The comment at `staticTranscriptRing.ts:163-165` ("Entry metrics come from the same `scrollback-budget` layout the row budget uses, so the ring never pays for a second full layout pass") describes a row budget that no longer reads this layout.
  - Dead branches the mode keeps alive: `entryLines`' tool case (`transcriptEntryLayout.ts:263-272`) has a `'scrollback'` branch (`wrapDisplayLines(lines, columns)`, no width) that no caller reaches (the two `'scrollback'` callers are `TranscriptEntry.tsx:108`, which returns `ToolUseRow` for tools first, and the default); and `fullTranscriptEntryLayout` (`:342-364`) asks for the `'scrollback-budget'` tool lines and then throws them away to rebuild with `showFullOutput: true`.
  - Consumers: `transcriptEntryLayout` 7 production files, 0 tests; `fullTranscriptEntryLayout` 3 production files (`state/transcriptLines.ts`, `runtime/headless/taskAttach.ts`), 0 tests.
- **Better design:** the layout takes the two facts its callers hold, not a mode name: `{ tail: number | 'all', elide: boolean }` (K11's shape). The ring calls the same elided layout `<Static>` paints, so its totals are the painted rows. `fullTranscriptEntryLayout` becomes the one unelided caller and passes `showFullOutput` itself, with no after-the-fact tool rebuild.
- **Deleted:** `TranscriptEntryLayoutMode`, the unreachable `'scrollback'` tool branch and its `useRichDisplay` flag, the discard-and-rebuild in `fullTranscriptEntryLayout`, the false comment.
- **Size:** about 60 changed lines, 3 files.
- **Risk / owner decision:** none for the structure. The ring pricing painted rows changes when history is trimmed (later, and never because of one long output); that is the intended behavior per the ring's own header, but a reviewer should confirm on a real TTY.

### CC-2: A user row is an "inquiry continuation" because its text matches a regex, tested in four places at layout and paint time

- **Package:** cli (fix lands in harness row model or texra inquiry plugin)
- **Flags:** a UI renderer repairing a data-model problem; information leakage; repetition
- **Evidence:**
  - `panes/transcriptEntries.ts:17-18` `INQUIRY_CONTINUATION_RE = /^\[inquiry\]\s+\S+\s+(?:answered|dropped by user)\.(?:\n|$)/`, exported as `isInquiryContinuationText` (`:39`).
  - The sentence it matches is written by the app: `packages/texra/src/tools/inquiry/inquiryActions.ts:66` `` `[inquiry] ${threadId} answered.` `` and `:90` `` `[inquiry] ${threadId} dropped by user.` ``. Rewording either line silently turns every continuation into a full-width inverse user band.
  - Four readers: `transcriptEntries.ts:165` (`userPromptAwaitsLiveContinuation`: whether scrollback may print the row), `transcriptEntryLayout.ts:295` (bottom margin), `:319-321` (top margin), `TranscriptEntry.tsx:40-41` (colour and fill). Consumers: 3 production files, 0 tests.
  - No other host parses this text (`grep '\[inquiry\]'` over `packages/texra/src/ui`, `packages/extension/src`, `packages/desktop/src`, `packages/harness/src/shared`: no hit), so the terminal is the only surface that distinguishes the two kinds of user row, and it does so from prose.
- **Better design:** the row says what it is. The follow-up the inquiry plugin delivers is already not a typed prompt; the projected `user` row carries that (an `origin`/`source` discriminant on the row, as `log` rows already carry `origin: 'local'`, read at `TranscriptEntry.tsx:87`). The TUI's four sites read the field; the layout table can then hold the continuation's geometry as data.
- **Deleted:** `INQUIRY_CONTINUATION_RE`, `isInquiryContinuationText`, three inline re-tests.
- **Size:** about 40 lines, 4 files in cli plus the row producer.
- **Risk / owner decision:** **owner decision**: adds a field to the transcript row (a stored/wire shape in `@texra-ai/harness/transcript`).

### CC-3: The terminal re-decides what a tool card shows by knowing how the shared row model built it

- **Package:** cli (rule moves to harness `shared/transcript`)
- **Flags:** information leakage; repetition (a rule with two owners); special and general code mixed
- **Evidence:**
  - `packages/harness/src/shared/transcript/toolRowModel.ts:250-275` heads its rule "Output suppression — the one ruleset" and ends "terminal economy is a paint-time head/tail elision, never a decision to drop the data". `panes/toolRenderers.tsx:1-12` repeats it: "The row's *content* is decided once, host-agnostically, by `toolRowModel`".
  - `toolRenderers.tsx:249-262` `isHeaderRedundantSection` then drops sections: a `file` section with no line range because "`deriveToolInputPreview` read the very same `path`/`file_path` key to build the preview" (`:238-239`), an unlabeled `yaml` code section because it is "the unlabeled `yaml` dump the shared default builder emits", and a `shell` one depending on `toolDisplayKind(toolUse.toolName) === 'bash'`. Each test is a fact about a builder in `toolRowSections.ts`, restated from outside; a builder that changes its label or language changes what the terminal shows with no compile error.
  - `:370-375` `cardPaintsOutput` re-reads `model.outputSuppression` and adds `isMcpToolName(toolUse.toolName) || toolUse.toolName === AGENT_TOOL_NAME` to decide whether "rendered-by-sections" really rendered the output. `outputSuppression` has one consumer outside its module, this one (grep over `packages/*/src`), so the enum's six cases exist for a reader that then needs tool names to interpret one of them.
  - `:163-166` `toolErrorLines` and `:426-428` `showsNoOutputMarker`: the "(error)" and "(no output)" markers are split, one decided in the model and one here.
- **Better design:** the model states both facts as data. Each `ToolSection` the header already says carries `restatesHeader: true` (set by the builder that knows it read the same key); the model exposes `outputPainted: boolean` (the card shows this exact output somewhere) instead of a reason enum a reader has to decode. The terminal keeps only width and elision. `2026-11-14-tool-card-result-and-delivery-shapes.md` is about the stored result shape and lists none of this.
- **Deleted:** `isHeaderRedundantSection`, `cardPaintsOutput`, the `isMcpToolName` / `AGENT_TOOL_NAME` / `toolDisplayKind` imports in the painter, `ToolOutputSuppression`'s reason literals nothing else branches on.
- **Size:** about 90 lines, 3 files (`toolRenderers.tsx`, `toolRowModel.ts`, `toolRowSections.ts`).
- **Risk / owner decision:** `ToolRowModel` is exported from `@texra-ai/harness/transcript`: **owner decision** on the field change. The webview formatter (`packages/texra/src/ui/progress/formatters/logFormatters/toolFormatters.ts`) should be read for whether it wants the same `restatesHeader` cut.

### CC-4: The corner gutter is written into strings by three functions and parsed back out by a fourth

- **Package:** cli
- **Flags:** conjoined methods; repetition; non-obvious code
- **Evidence:**
  - Writers: `render/transcriptRowLines.ts:66-70` `cornerBlock` (`` `${TOOL_OUTPUT_CORNER} ${line}` `` / two spaces), `panes/toolRenderers.tsx:122-132` `cornerRows` (the same gutter as spans), `:306-313` `patchTextLines` (the same string again), `ToolUseRow.tsx:47-50` (again, for the patch label).
  - Reader: `panes/transcriptEntryLayout.ts:153-170` `wrapDisplayLine` tests `line.startsWith(CORNER_PREFIX)` and otherwise measures leading whitespace with `/^\s+/` to rediscover the continuation indent `cornerBlock` chose. A body line that itself starts with whitespace (indented code in a `thinking` body) is indistinguishable from a gutter, so its own indent becomes the hanging indent of its wrapped rows.
  - `transcriptRowBodyLines` documents the coupling: "unwrapped lines already carrying their corner/indent gutter; the caller wraps them to its own width" (`transcriptRowLines.ts:87-90`).
  - Consumers: `cornerBlock` 1 file, `transcriptRowBodyLines` 3 production files, `elidedTextLines` 2, 0 tests each.
- **Better design:** a block is `{ lines }` and the gutter is applied once, after wrapping, by the layout that owns the width: `transcriptRowBodyLines` returns bare terminal-safe lines; `entryBodyLines` wraps to `columns - 2` and prefixes `⎿ ` / two spaces. The tool painter's `cornerRows` is the span form of the same one function.
- **Deleted:** `cornerBlock`, `CORNER_PREFIX` detection, `leadingWhitespacePrefix`, `wrapDisplayLine`; one of the two gutter builders.
- **Size:** about 50 lines, 3 files.
- **Risk / owner decision:** none.

### CC-5: Terminal width and row count are optional through the whole transcript path, with four hand-picked defaults no production caller reaches

- **Package:** cli
- **Flags:** an option for a special case; pass-through variable; overexposure
- **Evidence:**
  - Defaults: `transcriptEntryLayout.ts:26` `DEFAULT_TRANSCRIPT_COLUMNS = 80`; `ToolUseRow.tsx:21` `PATCH_PREVIEW_FALLBACK_WIDTH = 80`; `toolRenderers.tsx:50,70` `MAX_HEADER_PREVIEW = 80` returned when `columns === undefined`; `ConversationPane.tsx:28` `DEFAULT_TRANSCRIPT_ROWS = 24` with `props: ConversationPaneProps = {}`.
  - `width?: number` on `TranscriptEntry`, `LiveTranscriptEntry`, `ToolUseRow`, `PatchPreview`, `SessionHeaderBlock`, `StaticConversationTranscript`, `transcriptEntryLayout`, `staticTranscriptItemMetrics`, `staticTranscriptItemsTotals`, `trimStaticTranscriptItems`, `retainedStaticTranscriptTail`, `ensureStaticSessionHeader`, `estimateLiveTranscriptEntryRows`, `selectTranscriptEntriesForViewport`.
  - Every production call passes one: `ConversationRegion.tsx:163-183` passes `transcriptWidth` / `columns` / `conversationRows` from `useWindowSize()`; `StaticConversationTranscript.tsx:187` normalizes once and passes `normalizedWidth` down; `advanceScrollback`'s `ScrollbackInput.width` is already `number` (`staticTranscriptRing.ts:561`) and then loses the type as it is forwarded to five `width?` parameters.
  - The one place an absent width is meaningful is `toolUseMarginBottomRows` (`toolRenderers.tsx:476`) and `fullTranscriptEntryLayout`'s `showFullOutput` call, where "no width" means "plain projection": a second meaning carried by the same `undefined`, and the cache key spells it `'d'` (`:448`).
  - `ConversationPane.tsx:60-63` computes `metadataWidth` from "either, both or neither" of two optional widths for the same reason.
- **Better design:** width is a required `number` from the one `useWindowSize()` read down; the plain projection is its own function (`toolUsePlainLines(row)`), not the styled one with a missing argument.
- **Deleted:** four default constants, about fourteen `?` marks and their `?? fallback` branches, `transcriptColumns`' non-finite guard, the `'d'` cache key, `ConversationPaneProps`' optionality.
- **Size:** about 70 lines, 8 files.
- **Risk / owner decision:** none; `src/test-kernel/cli/ToolRenderers.vitest.ts` is the one suite that calls `toolUseDisplayLines` and would pass a width.

### CC-6: The terminal title decides "running / approval / idle" beside the harness function every other host calls

- **Package:** cli
- **Flags:** repetition (a rule with two owners)
- **Evidence:**
  - `packages/harness/src/shared/session/sessionView.ts:391-400` `sessionActivity(view)`: "The project-level activity every title and status pill shows, read from the view and nothing else". Consumers: `packages/desktop/src/main/desktopWindowTitle.ts:27`, `packages/extension/src/frontend/statusBar/taskStatusBar.ts:51`.
  - `tui/terminalTitle.ts:46-59` `terminalTitleState` computes the same three-valued `SessionTitleState` from `attentionRequests`, `canStopRootRun` and `rootRunIds.some(isWorking)`. It differs in scope (this chat's runs, a launch in flight) but restates the precedence (approval over running over idle) and the `isWorking` test.
- **Better design:** `sessionActivity` takes the scope as data: `sessionActivity(view, { runs?: ReadonlySet<RunId> })`. The terminal passes `sessionRunIds` and ORs in the one fact the view cannot hold (a launch in flight, `canStopRootRun`).
- **Deleted:** the body of `terminalTitleState` (12 lines) and the `attentionRequests` / `rootRunIds` / `isWorking` imports in `terminalTitle.ts`.
- **Size:** about 25 lines, 2 files.
- **Risk / owner decision:** **owner decision**: `sessionActivity` is a published `@texra-ai/harness/schemas` export; the parameter is additive.

### CC-7: Status facts the app's `@ui/copy` formats are formatted a second time in the status bar and `/status`

- **Package:** cli
- **Flags:** repetition; information leakage (batched thin items of one species)
- **Evidence:**
  - "The root of this run's task": `tui/sessionStatus.ts:66` and `panes/statusBarDisplay.ts:295` both write `view.runs.get(run.ancestors[0]?.id ?? run.id)` (the only two hits for `ancestors[0]` in `packages/*/src`), one to build `taskCostStatus`, one for `taskCostSegment`. `taskCostStatus` 2 production files, 0 tests.
  - Quota percent: `statusBarDisplay.ts:236` `Math.max(0, Math.round(limitingWindow.percentRemaining))` and colours `remaining === 0` red; `packages/texra/src/ui/copy/subscriptionUsage.ts:39-42` `formatSubscriptionUsagePercent` exists to never round a nonzero figure to 0 or a sub-100 one to 100. The bar can print "0% left" in the error colour with quota remaining.
  - Which window limits: `statusBarDisplay.ts:232-234` sorts by `percentUsed`; the settings row (`packages/extension/src/settingsView/frontend/components/profile/SubscriptionUsageRow.ts:157`) shows every window. "The limiting window" is a fact of the snapshot with no owner.
  - Request-kind vocabularies local to the TUI: `SubagentListDisplay.ts:14-21` `PENDING_APPROVAL_ROW_LABELS`, `statusBarDisplay.ts:55-70` `statusKindForApproval`, `appInteractionPolicy.ts:18-28` `APPROVAL_FOREGROUND_MAX_ROWS`: three exhaustive tables over `PendingRequestKind` in three files. Open PR #14955 touches `SubagentListDisplay.ts`; its version was not seen to merge them.
  - `sessionStatus.ts:19` imports the type `BypassState` from `panes/statusBarDisplay.ts`, which is `ReturnType<typeof runBypasses>` from the harness: a pass-through alias through a sibling renderer.
- **Better design:** `taskRootOf(view, run)` beside `runBypasses` in the harness view helpers (or a `rootId` the `RunView` already implies); `limitingWindow(snapshot)` and a "percent left" formatter in `@ui/copy/subscriptionUsage` with the same no-false-zero rule; one `REQUEST_KIND` table (`{ label, noun, maxRows }`) in `state/approvalQueue.ts`.
- **Deleted:** one root lookup, the local rounding, two of three request-kind tables, the `BypassState` alias.
- **Size:** about 60 lines, 6 files.
- **Risk / owner decision:** the quota rounding changes visible text at the edges (0.4% left reads "<1% left" rather than "0% left"): small **owner decision**.

## Good modules here

- `panes/staticTranscriptRing.ts` `advanceScrollback` / `StaticTranscriptTotalsAccumulator`: one record, append-or-new-origin, margin collapse priced once (its metric input is CC-1's problem, not its structure).
- `state/cliState.ts` `ChatState` + `chatField`/`fieldOf`: one value, one writer per field, `/clear` is a new value.
- `state/approvalQueue.ts` `TuiRequest`: derived from the wire union, so a new request kind fails to compile in the modal dispatcher.
- `panes/transcriptEntries.ts` `ROW_KIND_IS_WIDGET` and `transcriptEntryLayout.ts` `ROW_GEOMETRY`: exhaustive `satisfies Record<TranscriptRowKind, …>` tables.
- `panes/statusBarDisplay.ts` `fitStatusBarLeftSegments`: one fitting sweep over `priority` + `policy` (K7 landed cleanly).
- `state/transcript.ts` `mergeLocalNotices`: a join of two seq-ordered inputs, no stamping.

## Considered and left alone

- `presentedOrder` module `Set` written inside the `currentApproval` computed (`approvalQueue.ts:207-232`): catalogue K11 records it as a kept cache.
- `bindSessionView`'s module global (`state/sessionView.ts`): lenses-2 README row; `TuiSession`'s constructor writing `rootLaunch`: K11.
- The Esc-chord machinery in `App.tsx:330-470` (`pendingEscapeInterrupt`, `chordResolvedBy`, `queueMicrotask`): K-cli table row and V-compromises.
- The bell re-deriving "turn finished": refuted `CLI-tui-bell-from-attention`.
- Status-bar hint availability computed in `StatusBar.tsx:249-258` beside the key handler's own gates in `App.tsx:505-545` (Ctrl-T's hint needs `rows.length > 0`, the key only needs an active run): the split between App and bar was K7's second half and landed; what remains is one mismatched predicate, a nit.
- `HEADLINE_CACHE` / `entryLinesCache` / `styledLinesCache` / `SAFE_TEXT_CACHE` `WeakMap` memos keyed on immutable row objects: correct by the view's replace-never-mutate rule, and each has more than one reader per frame.
- `trimAssistantTranscriptLead` and `normalizeKnownHtmlForCliMarkdown` (model text cleaned at headline time): terminal-only presentation of model output, memoized per row; no data-model owner to move it to.
- `SCRIPT_POPUP_VIEW`, `inputBarContentRows`, `sessionViewFailure` held outside `ChatState`: process- or mount-scoped by their own comments; no reset hook exists for them.

## Summary

| Id   | Title                                                                                                   | Package       | Flags                                                                    | Size               | Owner decision?                      |
| ---- | ------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------ | ------------------ | ------------------------------------ |
| CC-1 | Layout `mode` means both "print everything" and "price the scrollback"; ring prices unpainted rows (K11 remainder) | cli           | option for a special case, special-general mixed, false comment, non-obvious | ~60 lines, 3 files | no (confirm trim behavior on a TTY)  |
| CC-2 | A user row is an inquiry continuation because its text matches a regex, tested in four places           | cli + texra/harness | renderer repairing data model, information leakage, repetition      | ~40 lines, 5 files | yes (transcript row field)           |
| CC-3 | The terminal re-decides tool-card content by knowing how the shared row model built it                  | cli + harness | information leakage, repetition, special-general mixed                   | ~90 lines, 3 files | yes (`ToolRowModel` fields)          |
| CC-4 | Corner gutter written into strings by three functions and parsed back by a fourth                       | cli           | conjoined methods, repetition, non-obvious                               | ~50 lines, 3 files | no                                   |
| CC-5 | Width and rows optional through the transcript path with four defaults no production caller reaches     | cli           | option for a special case, pass-through variable, overexposure           | ~70 lines, 8 files | no                                   |
| CC-6 | Terminal title re-derives the harness's `sessionActivity`                                               | cli + harness | repetition                                                               | ~25 lines, 2 files | yes (additive SDK parameter)         |
| CC-7 | Status facts `@ui/copy` owns formatted again in the bar and `/status` (task root, quota percent, request-kind tables) | cli + texra   | repetition, information leakage, pass-through                            | ~60 lines, 6 files | small (quota text at the edges)      |
