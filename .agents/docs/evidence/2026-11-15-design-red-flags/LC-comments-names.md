# LC: comments and names, whole repo (lens)

Read on `main` at `d70ad92` (the commits after it on this branch add only
audit reports). Flags: comment restates code (false comments, document
citations), vague name, and the root `AGENTS.md` "Plain names" table.

Earlier coverage read first: `../2026-11-07-design-red-flags-lenses/interface-comments.md`
(IC1 to IC7), `../2026-11-07-design-red-flags-lenses/names.md` (NM1 to NM10),
`../2026-11-08-design-red-flags-lenses-2/README.md` sections 1, 2, 3 and 5
(L2-1 to L2-5), and the catalogue rows for the open ids IC6, NM1, NM9, NM10
(IC7 and NC-B are landed). Area reports in this folder that already list false
comments or refused words, and are not repeated here: HR-2 (runtime README,
`helpers.ts`, `checkToolResultTextLimit`, `toolUse.*` spans), HS-1
(`traceAssembler.ts` header), HT-6 and HT-8(b), TC-2, TC-5
(`repositoryOverview.ts` header), TC-8, TC-11(f), TT-8 (`latex/README.md`, the
agent-CLI import headers), TU-8 (`ui/progress/` citations and refused words),
LM-6 (llm refused words and comments), LM-7 (llm README), CL-6(5, 7).

## Numbers

Comment lines (`^\s*(//|/\*|\*)`) over all lines, `packages/*/src`, tests
excluded:

| Package      | Comment / total | Share |
| ------------ | --------------- | ----- |
| harness      | 19,618 / 79,150 | 24.8% |
| texra        | 14,923 / 81,527 | 18.3% |
| llm          | 2,219 / 12,094  | 18.3% |
| cli          | 6,563 / 44,932  | 14.6% |
| desktop      | 2,177 / 14,491  | 15.0% |
| extension    | 1,971 / 15,758  | 12.5% |
| trace-viewer | 106 / 407       | 26.0% |

Five largest files: `harness/src/shared/session/sessionViewUpdate.ts` (1,078),
`harness/src/agent/runtime/loop/toolUseDispatch.ts` (1,011),
`cli/src/chat/chatSessionController.ts` (1,007),
`desktop/src/renderer/main.ts` (936),
`harness/src/agent/runtime/runRegistry.ts` (887).

How the false comments were found: three scripts over every comment in
`packages/*/src` (kept in the session scratchpad, not the repo): (1) every
backticked or `{@link}` identifier checked against every identifier and
string in `packages/`, `src/` and `scripts/` (112 hits; after removing SQLite
codes, env vars, upstream names and historical field names in
`rowVersions.ts` and names already in an area report, the LC-1 sites survive); (2) every file name or alias path in a comment
checked against the tree (80 hits, mostly config file names and URLs; three survive); (3) every "`symbol`
(`file.ts`)" pair checked for the symbol in that file (1 survives). Then
history comments ("used to", "the old", "pre-migration", "legacy") and
claims of uniqueness ("the only writer", "the one caller") were read by hand.

## LC-1: Comments name symbols, files and service keys that were renamed or deleted

- flags: comment restates code (false comments)
- package: texra (touches harness and cli)
- kind: bug (false comments)
- size: S
- earlier: none for these lines. IC1 to IC5 and the lens-2 batch fixed the
  set found on 2026-11-07; HR-2 has the runtime README, `helpers.ts`
  (`AgentTrace.ts:8,64`, `TraceEmitter.ts:6`) and `checkToolResultTextLimit`;
  TT-8 the `latex/` README; LM-7 the llm README; EX-7 the extension guide.
  These are the ones the scripts found outside them.
- open PR: #14953 touches `runtimeRequest.ts` and `server/protocol.ts` but
  not these lines (read with `git diff origin/main...origin/claude/optimistic-cori-q0n270`).

**Evidence.** Each was read against the code it names.

_harness_

- `shared/session/runtimeRequest.ts:102-103` and
  `agent/runtime/executeAgent.ts:231-232`: "as a start carries them
  (`StartOptions.apiKeys`)". There is no `StartOptions` in the repo; the
  start's input is `StartInput` (`effect/sessions.ts:116`
  `ResumeInput = Pick<StartInput, 'tools' | 'interactive' | 'apiKeys'>`).
- `shared/session/sessionViewAccess.ts:1-4`: "its tag is
  `SessionViewAccess` (`sessionInputs.ts`)". The tag is
  `shared/session/runHistory.ts:310`; `sessionInputs.ts` does not mention it.

_texra_

- `controllers/server/protocol.ts:277` and `controllers/server/client.ts:66-68`:
  the same `StartOptions.apiKeys`.
- `agent/teams/teamPlan.ts:3-6`: "The harness stores only the team
  reference a workspace runs (`WorkspaceAgentsController.setTeam`)". No
  `setTeam` exists; the writer is `setDefaultTeam`
  (`harness/src/agent/workspaceAgents/WorkspaceAgentsController.ts:364-369`).
- `latex/arxivProcessor.ts:501-506` and `latex/formatter/indentDirectory.ts:98-101`:
  "The tolerant listing is the facade's `readDir`: the provider typed
  ordinary entries from the `readdir` dirent, but a _symlink_ dirent still
  ran one `stat` (`fileTypeFor` → `resolveSymlinkType`)". There is no
  facade, provider, `fileTypeFor` or `resolveSymlinkType` anywhere in
  `packages/`. The listing both call is `readDirectoryTypedTolerant`
  (`harness/src/utils/files/fsDurability.ts:239-262`), which types a
  symlink as `SymbolicLink` from its dirent and `lstat`s only an
  `Unknown` entry (`:198-203`, `:250-258`): a symlink runs no `stat` at
  all. The reason the comment gives for the tolerant form (one bad entry
  must not fail the listing) still holds; the mechanism it describes is
  gone.
- `latex/arxivProcessor.ts:53-57`: "`downloadSource` also fails with it".
  The function is `downloadArxivSource` (`:416`); `downloadSource` is only
  its span name. The same block's "the old p-retry `AbortError`" is LC-2's.
- `tools/setup/platform.ts:78-83`: the service is
  "(`@texra/setup/SetupPlatform`)"; its key is
  `'@texra-ai/texra/tools/SetupPlatform'` (`:87`), and `@texra/setup/*` is
  no alias (`tsconfig.json` paths).

_cli_

- `bin/texra.ts:40-42`: "see runtime/executeCli.ts"; the file is
  `runtime/headless/executeCli.ts` (`executeCliConfig` at `:174`).
- `chat/tui/render/ansiMarkdown.ts:49-51`: "same pattern as
  `runtime/style.ts`'s `createCliStyle`"; the file is
  `runtime/terminal/style.ts:33`.

**The design decision behind it.** None; each rename or move left the
comments that pointed at the old name. `npm run gate:docs` checks repo
paths only when they carry a package prefix, and nothing checks a
backticked identifier.

**The better design.** Correct the nine sites: `StartInput.apiKeys` (four),
`runHistory.ts` for the tag, `setDefaultTeam`, `downloadArxivSource`, the
real service key, the two CLI paths. In `arxivProcessor.ts` and
`indentDirectory.ts` keep only the reason ("one unreadable entry must not
fail the listing; `readDirectoryTypedTolerant` drops that entry instead"),
which is already the callee's doc, so the two call-site comments can shrink
to the call. A cheap guard against the next round is the script this lens
used (backticked identifiers checked against the tree), as an advisory
`gate:docs` step; that is a tooling decision for the owner, not part of
this fix.

**What we give up, and risk.** Nothing.

**How I tried to refute it.** Grepped each name `-w` across `packages/`,
`src/` and `scripts/` (code and strings) and found only the comment;
read `readDirectoryTypedTolerant` and `readDirectoryTyped` whole for the
symlink claim; checked `tsconfig.json` for an `@texra/setup` alias (none).
Dropped from the scripts' output: `RunTrace.lost` (`sessionEvents.ts:117`:
loose but the `lost` read is the run trace module's, `runTrace.ts:146`),
`PinnedModels.vitest.ts` and `protocolStability.vitest.ts` (both exist and
check what the comments say), every upstream name (citty, markdown-it,
LaTeX Workshop, the Codex SDK, MCP, JSON-RPC), the historical field names
in `rowVersions.ts` (a version log, settled in IC's "Already settled").

## LC-2: Comments that narrate the code they replaced, or cite a design section, in place of the reason

- flags: comment restates code (history and document citations)
- package: texra (touches harness, cli, desktop)
- kind: docs
- size: S
- earlier: IC7 and L2-2 (landed) removed the citations and "used to"
  stories found on 2026-11-07/08. EX-7 lists the same pattern in
  `packages/extension`, TU-8 the progress view's citations, DT-8 the
  desktop's "(8.3)". This is the rest of the repo. `formSlot.ts` is an L2-2
  remainder (its "#12908" went; the story stayed).
- open PR: #14950 touches `transcriptRow.ts` and #14953
  `runRecords.ts`, `runtimeRequest.ts`, `diffComputation.ts` and
  `createMarkdownProcessor.ts`, none of these lines.

**Evidence.** A reader of the current code never saw the code these
comments compare against.

_harness_

- `agent/runtime/run/tools.ts:38-40`: bytes that are not JSON stay a string
  the schema refuses "exactly as the handler path did".
- `tools/gitignore.ts:92-95`: "the same way the old minimatch-based parser
  did".
- `utils/files/fsDurability.ts:228-230`: a probe would make the tree
  "render empty where the pre-migration listing showed it".
- `shared/transcript/transcriptRow.ts:355-356`: "the figures its stats
  entry used to repeat as a second row".
- Design-section citations: `shared/schemas/runRecords.ts:85` ("one run
  model, section 3.4") and `shared/session/runtimeRequest.ts:108` ("one run
  model, section 3.7"), section numbers of
  `.agents/docs/implemented/architecture/2026-09-10-one-run-model.md`
  ("3.4 Result", "3.7 Waiting on a person"): a pointer where the root guide
  asks for the reason ("No document citations in code").

_texra_

- `shared/constants/latexToolchain.ts:443-445`: "the copies it replaces
  were kept in step by hand".
- `latex/acceptedFileTarget.ts:330-331`: "as the platform delete this
  replaced did".
- `agent/output/diffComputation.ts:92`: "as the `isFile` this replaces did".
- `utils/files/pastedImageUtils.ts:75-77`: "as the sweep it replaced did".
- `latex/arxivProcessor.ts:55-56` ("the old p-retry `AbortError`"),
  `:283` ("the old regex silently dropped"), `:624-627` ("Every non-success
  exit used to leave `.arxiv-download-<id>/` behind").
- `latex/extractFileDependencies.ts:97-99`: "which is what `stopOnError:
  false` used to do".
- `latex/latexParsingUtils.ts:45-46`: "the two consumers that used to keep
  disjoint lists".
- `ui/markdown/createMarkdownProcessor.ts:150-152`: "without the old cast".
- `ui/styles/commonViewStyles.ts:33-34`: "InstructionPanel and WorktreeChip
  both used to carry their own".
- `ui/wa/waColorScheme.ts:96-97`: "Both hosts ... used to hand-roll this
  two-line dance".
- `ui/progress/styles/logEntryStyles.ts:182-184` and
  `ui/progress/formatters/constants.ts:10-12`: "replaces the former emoji
  map", "the colored emoji used to carry" (TU-9 may delete the second
  file's table; the CSS comment stays either way).

_cli_

- `runtime/headless/approvalAdapter.ts:2`: "(one run model, 3.7)".
- `runtime/headless/approvalAdapter.ts:68-71`: "what used to settle as a
  rejection".
- `chat/tui/state/formSlot.ts:3-8`: "Both used to write the signal
  directly, so whichever arrived second unmounted the first".

_desktop_

- `main/desktopPtyHost.ts:117-118`: "the Windows `Path`-vs-`PATH` rule this
  used to hand-roll".

**The design decision behind it.** None: each comment was written in the
commit that replaced the old code, as the reviewer's diff explanation, and
stayed after the diff was gone.

**The better design.** Keep the reason, drop the comparison: "a symlink
counts by its target" instead of "as the `isFile` this replaces did"; "one
list, read by citation extraction and by latexdiff's `--exclude-textcmd`";
"a request answers the opened request it names" for the two "one run
model" citations. Where the comment holds nothing once the history goes
(`createMarkdownProcessor.ts:150-152`, `commonViewStyles.ts:33-34`,
`waColorScheme.ts:96-97`'s first sentence), delete it. About 25 comment
lines change; no code.

**What we give up, and risk.** The history, which `git log -S` keeps.

**How I tried to refute it.** Read each line in context to keep only those
whose comparison carries no reason of its own. Left alone:
`desktopShortcutRegistry.ts:80-82` (the "used to steal" clause is the
reason a capturing listener is not used), `databaseLayer.ts:97` ("beside
the stores it replaces" names the legacy JSON stores the root guide says
to leave in place), `SubscriptionOAuthCoordinator.ts:199-203` ("the one it
replaced" is a token, not code), and every issue number that sits beside
its reason.

## LC-3: The refused words, counted per package: "as a rule, not a PR" moved `settle` by a quarter and left the small words untouched

- flags: vague name (the "Plain names" table)
- package: harness (most of the identifiers; touches texra, cli, and the
  per-package lists below)
- kind: refactor (renames; two strings a person reads, two strings a model
  reads, and two public SDK members under "Needs your eye")
- size: L in total, as one rename commit per package (harness M, texra S
  outside `ui/progress/`, cli S)
- earlier: NM1 and NM9 (open, "as a rule not a PR"). Already handed to
  their area owners this round, and not repeated in the lists below:
  TU-8 (`ui/progress/`: `RunMenuAction.arm`, `emitRuntimeArm`,
  `settleHost*`, `refusal`), LM-6 (llm: `admit`, `settle`, `Folded`),
  DT-8 (desktop), EX-7 (extension), RT-7(e) (test support `parked*`),
  HR-2 (`toolUse.*` spans).
- open PR: #14950 touches `staticTranscriptRing.ts` and #14953
  `databaseLayer.ts`, neither renaming these identifiers.

**Evidence.** Counted with a tokenizer over `packages/*/src` that splits
code, comments and strings and splits identifiers at camel case. Strings
are counted apart and are not part of the rename: persisted and wire
spellings keep theirs (`child.park` row type, `desktop:settlePrompt` IPC,
`RunAdmissionClosed` and the `*Refused` `_tag`s, `Effect.fn` span names).
Legitimate senses are subtracted: case folding (`foldCase`, the env-name
`fold` locals in `envFlags.ts:86` and `nodeWorkspace.ts:74`), Monaco's
`folding`, `Stream.runFold`, the verbs `foldRunRows`/`foldSkillSources`,
the `RowRead.fold` reducer field, `arm64`, cursor and file moves, CSS
`transition`, "astral plane", and every llm "refusal" (a model refusing).
Comment counts for `fold`, `move` and `transition` are regex
approximations of the noun sense.

| Word (banned sense)                 | Ctx     | Total | harness | texra | llm | cli | desktop | extension | trace-viewer |
| ----------------------------------- | ------- | ----- | ------- | ----- | --- | --- | ------- | --------- | ------------ |
| settle, settled, settlement, …      | ident   | 300   | 198     | 31    | 2   | 40  | 21      | 8         | 0            |
|                                     | comment | 199   | 139     | 10    | 1   | 17  | 19      | 13        | 0            |
| admit, admission, …                 | ident   | 74    | 51      | 18    | 5   | 0   | 0       | 0         | 0            |
|                                     | comment | 113   | 77      | 28    | 5   | 2   | 0       | 1         | 0            |
| fold (noun), folded                 | ident   | 24    | 14      | 0     | 10  | 0   | 0       | 0         | 0            |
|                                     | comment | ~114  | 99      | 10    | 0   | 4   | 1       | 0         | 0            |
| park, parked                        | ident   | 9     | 9       | 0     | 0   | 0   | 0       | 0         | 0            |
|                                     | comment | 17    | 15      | 1     | 0   | 1   | 0       | 0         | 0            |
| arm (of a union or handler table)   | ident   | 57    | 6       | 33    | 0   | 14  | 2       | 2         | 0            |
|                                     | comment | 94    | 49      | 24    | 0   | 4   | 9       | 8         | 0            |
| move (noun)                         | ident   | 15    | 15      | 0     | 0   | 0   | 0       | 0         | 0            |
|                                     | comment | ~10   | 4       | 1     | 1   | 2   | 1       | 1         | 0            |
| grammar                             | comment | 14    | 4       | 7     | 0   | 3   | 0       | 0         | 0            |
| transition (rule, state transition) | comment | ~6    | 2       | 2     | 0   | 2   | 0       | 0         | 0            |
| tombstone                           | ident   | 9     | 9       | 0     | 0   | 0   | 0       | 0         | 0            |
|                                     | comment | 3     | 3       | 0     | 0   | 0   | 0       | 0         | 0            |
| hydration, rehydrate                | comment | 4     | 0       | 0     | 0   | 4   | 0       | 0         | 0            |
| seam                                | ident   | 4     | 0       | 0     | 0   | 4   | 0       | 0         | 0            |
|                                     | comment | 7     | 0       | 0     | 0   | 7   | 0       | 0         | 0            |
| plane                               | comment | 19    | 14      | 0     | 0   | 1   | 1       | 1         | 2            |
|                                     | string  | 2     | 2       | 0     | 0   | 0   | 0       | 0         | 0            |
| ledger, spine                       | all     | 0     |         |       |     |     |         |           |              |
| refusal, refuse(d) (our rejection)  | ident   | 413   | 250     | 87    | —   | 64  | 6       | 6         | 0            |
|                                     | comment | 526   | 307     | 110   | —   | 69  | 15      | 22        | 3            |

Against `names.md`'s N9 (same kind of count, `433d874`): `settle`
identifiers 398 → 300 and comments 286 → 199 to 217; `admit` 89 → 79 raw
identifiers; `arm` 63 → 57; `park` 9 → 9; `tombstone` 9 → 9; `seam`
4 → 4; `hydrat` 6 → 4; `plane` 21 → 19 comments, and its two error
strings are still there. Every identifier N9 named for the small words is
unchanged. `refusal` is the largest: excluding the twelve `*Refused`
`TaggedError` classes and llm, 413 identifiers (`RequestRefusal` and
`appendLocalRequestRefusal`, `runReadRefusal`, `checkpointRefusal`,
`missingAgentRefusal`, `refusalTold`, …) name TeXRA's own rejection of a
request; a share of the comments mean a person's denial, which the table
allows only for a model.

**Identifiers to rename, by package** (excluding the areas already
assigned above):

- _harness_: `settled` (65 refs: `SessionCloseReport.settled`,
  `opResults.ts:44`; the `'settled'` call-status kind, `inFlight.ts`,
  `toolUseDispatch.ts`, `turnRowHandlers.ts`; `runRegistry.ts`'s
  `settled: Deferred`), `settle` (15, `transcriptUpdate.ts:42`),
  `settledRows`, `settlement`/`ScriptSettlement`/`SettleMessage`/
  `toSettleMessage` (`codeSandbox/`), `SettledToolResultSchema`,
  `callSettlementOf`, `settlementOf`, `settledPending`, `settledState`,
  `settlementSeqNo`, `settleCompactionActivities`, `settledThroughSeqNo`,
  `isSettledRow`, `isSelfSettledRow`, `IMMEDIATELY_SETTLED_ROW_KINDS`,
  `settledAt`/`isSettled` (`forkRun.ts`), `settleRun` (`runLoop.ts:63`),
  `advanceSettledRows`, `withinSettlementBoundary`, `unsettled`; `admitted`
  and `deleteAdmittedRun` (`deletionCleanup.ts:251-257`), `admit`/
  `admission` (`SessionRequests.ts:126,221`), `Admission` (`Inbox.ts:91`),
  `admittedTurn` (`ModelInvoker.ts:102`), `admitSwitch`
  (`modelAccess/routeDecision.ts`), `admitsNull` (`toolSchema.ts:55`),
  `admitTools`/`admitInput` (`sessionPrograms.ts:96,117`); `folded`
  (`run/AgentRun.ts:247`, `storage/runOwnership.ts:157,245`),
  `FoldedToolRow` (`shared/transcript/scriptStage.ts:35`); `parks`/`park`
  (`forkRun.ts:109-131`), `parked` (`loop/runLoop.ts:406`); `move`
  (`ModelInvoker.ts:692-806`, 13 refs, a `NextAttempt` case: `next`);
  `tombstone`/`tombstones` (`controllers/session/databaseLayer.ts:619-758`,
  `shared/session/database.ts:295`: `removal`); `arm`
  (`databaseLayer.ts:166-171` `displayUnion(…, arm?)`;
  `agent/runtime/ToolServices.ts:104,177` `fact(id, arm)`: `kind`).
- _texra_: `arm` (19, `controllers/session/openGuiWindow.ts:724-733`),
  `OwnHostArms` (`openGuiWindow.ts:141`, read by both GUI hosts),
  `SettingsArms` (`controllers/settingsView/settingsViewBody.ts:81`),
  `ApprovalArm`/`approvalDecisionArm` (`shared/session/surfaceDecision.ts:113,125`,
  read by the CLI too); `settle`/`settled` (`controllers/server/serve.ts:104`,
  `serviceSession.ts:534`), `requestSettled`/`openAndSettle`
  (`tools/lean/direct/leanServer.ts:161,562`: `waitQuiet`); `admitting`/
  `admitted`/`admission` (`controllers/server/serve.ts:157,207`,
  `service.ts:97`), `TaskAdmitted` (`server/protocol.ts:140`; an RPC
  success schema's TypeScript name, not its wire tag).
- _cli_: `settledRows` (22, `runtime/headless/taskAttach.ts:147`),
  `printableSettledRows`, `printSettled`, `settledSeq`, `settlementSeqNo`
  (`chat/tui/state/transcript.ts`), `settle` (`commands/service.ts:113`);
  `arm` (`chat/tui/state/subscribeApprovals.ts:152-161`,
  `approvalQueue.ts:365-371`, `forms/TasksForm.tsx:248-258`); `seamRows`
  (`chat/tui/panes/staticTranscriptRing.ts`, 4 refs and 7 comments).

**Strings a person or a model reads** (not persisted, so not exempt):
"Session publication after the plane closed" and "Session publication
dropped: the plane has closed" (`agent/runtime/sessionEventsLayer.ts:173,215`,
N9's two, moved from `SessionEvents.ts`); "The retry could not be settled."
(`texra/src/controllers/progressView/ProgressApiKeyRetryController.ts`);
"Session presenter stopped before settling" (`controllers/session/sessionStore.ts`);
"the session's rows did not settle within …" (`cli/src/chat/tui/runChatTui.tsx`);
"outside the admitted storage root" (`controllers/session/deletionCleanup.ts`);
and, to the model, "The script ended before this call settled." and
"Script call … is unsettled after its run." (`loop/toolUseDispatch.ts`),
"The script awaits a promise that no tool call will settle."
(`codeSandbox/codeSandbox.ts`), "A fork starts at a settled point of a
conversation" (`forkRun.ts`).

**Needs your eye.** Two members of the public SDK carry the word:
`LocalSession.settled` (`effect/sessions.ts:286-289`, "Wait until
everything already sent to the session is written, shown in the view, and
handled"; read by `cli/src/runtime/headless/executeCli.ts:397` and
`runChatTui.tsx:682`) and `SessionCloseReport.settled`
(`shared/schemas/opResults.ts:44`). The root guide exempts documented API
names it lists (`withPerKeyLane`, `SessionEvents`); these two are not
listed. Renaming them (`drained`, `allEnded`) is an SDK 0.x change and gets
its own commit.

**The design decision behind it.** NM1/NM9 decided the renames should
happen "as a rule, not a PR": each owner renames what it touches. A week
of that removed a quarter of `settle` (the files rewritten for other
reasons) and none of the other words, because a rename nobody is assigned
is nobody's diff.

**The better design.** One rename commit per package, from the lists
above, with the plain word from the table's right column and N1's
per-meaning names for `settle` (a call's result recorded: `finished` /
`resultOf`; a transcript row final: `final*`; the publisher drained:
`drained`; a value stopped changing: `waitQuiet`). The comment words go in
the same commits. A refusal pass needs a per-site read and is the one
part that can stay "as touched": `rejection` for TeXRA's own, `denial`
for a person's.

**What we give up, and risk.** Rename churn across ~90 files; merge
friction with open PRs that touch the same files (#14950, #14953). No
behavior changes; no persisted or wire string changes.

**How I tried to refute it.** For every identifier listed, checked that it
is not a persisted row type, `_tag`, settings key or IPC channel
(`rowVersions.ts`, `sessionEvent.ts`'s `durable(...)` list, the
`TaggedError` declarations); `'orphan-settlement'` is the `reason` literal
of `RunHistoryInconsistent` (`shared/session/runState.ts:78`), an
in-memory error, so it may be renamed too, but nothing branches on it.

## LC-4: `ResumeRefused` is two error classes with one `_tag` and different fields

- flags: vague name (one name for two things), non-obvious code
- package: harness
- kind: refactor
- size: S
- earlier: none (`names.md` N9 lists `ResumeRefused` only as a `_tag` that
  keeps its spelling; neither report saw that there are two)
- open PR: none

**Evidence.**

- `agent/runtime/resumeRun.ts:90-98`: a file-local
  `class ResumeRefused extends Schema.TaggedError<ResumeRefused>()('ResumeRefused',
  { answer: Union([{ failed: ResumeRefusalSchema }, { ownedBy: RunIdSchema }]) })`,
  raised at `:221` and caught by tag at `:151`
  (`Effect.catchTag('ResumeRefused', (refused) => … refused.answer)`) and in
  another module, `agent/runtime/delegation/childLaunch.ts:106`
  (`Effect.catchTag('ResumeRefused', ({ answer }) => …)`), which reaches it
  through `openResume`'s error type.
- `effect/errors.ts:58-65`: the exported SDK error
  `ResumeRefused` with `{ runId, reason: ResumeRefusalSchema, message }`,
  raised at `effect/sessionPrograms.ts:241`, exported from `index.ts:88`,
  documented on `Session.resume` (`effect/sessions.ts:214-219`) and caught
  by tag in `cli/src/runtime/headless/executeCli.ts:145`
  (`({ message }) => …`) and `texra/src/controllers/session/runActionPolicy.ts:35`.

Both are `Effect.catchTag('ResumeRefused', …)` targets. The compiler keeps
them apart only because no channel today carries both; a reader who greps
the tag finds two shapes, and the internal one's `answer.ownedBy` case is
not a refusal at all (the run is a child of an open call), which is why
`childLaunch.ts` words it "belongs to an open call".

**The design decision behind it.** The internal error is how
`openResume` ends a registry launch with no fiber behind it and still
hands its caller a value (`resumeRun.ts:86-89`, "told as the opening's
failure ... and answered as the refusal it carries"). The name was taken
from the public error it usually turns into.

**The better design.** Give the internal class its own name for what it
carries, a resume that did not open (`ResumeNotOpened` with `answer`), so
the public `ResumeRefused` is the only class with that tag. Two raise
sites, two `catchTag`s and the class line change; nothing outside the
harness sees the internal name.

**What we give up, and risk.** Nothing; the internal class is file-local
(not exported) and no row stores it.

**How I tried to refute it.** Checked that both classes are live (each
has a raiser and catchers), that the internal one is not exported
(`resumeRun.ts:90`, no `export`) and so cannot be the SDK's, and that no
test matches the `_tag` string of the internal one
(`grep -rn "ResumeRefused" packages/*/test src` reaches the public one
through `session.resume`).

## LC-5: Names that call two things by one word, still open from NM10, and one new pair

- flags: vague name (one name for two things)
- package: harness (touches texra, cli)
- kind: refactor
- size: M
- earlier: NM10 (c) `PluginRow`, (g) `Draft`, (k) `absentReason`, which
  waited on #14889's files; #14889 is merged (it is not in the open list),
  so they are remainders with nothing in their way. NM10 (h) (`RunView` and
  friends) is HS-5's this round; (a) is settled (catalogue: "the two
  statuses read different sources").
- open PR: #14949 and #14953 touch `settingsViewMessages.ts` and #14949
  `pickerOptions.ts`, without renaming these types.

**Evidence.**

- **`PluginRow`** is a harness type and an app type, both exported.
  `harness/src/tools/plugins.ts:59-62` (`{ value, parent }`, a stored row
  of a plugin's fact kind, on the public `@texra-ai/harness/plugins`
  entry, `plugins.ts:54`, read by `accepts`/`supersedes`, `:89-96`)
  and `texra/src/shared/settingsView/settingsViewMessages.ts:342` (a row
  of the Plugins settings page: `installed` or `mcp`), used by five files
  in texra, cli and extension (`controllers/settingsView/pluginRows.ts`,
  `ui/copy/plugins.ts`, `cli/src/commands/plugin.ts:13`,
  `cli/src/chat/tui/forms/PluginsListForm.tsx:23`,
  `extension/.../PluginCard.ts`, `PluginsTab.ts`).
- **`Draft`** is declared four times for four things:
  `harness/src/shared/session/transcriptState.ts:239` (one transcript
  update's working copy, `extends TranscriptWork`), `texra/src/shared/session/surface.ts:156`
  (the GUI composer's unsent message), `cli/src/chat/tui/input/draftAttachments.ts:94`
  (the TUI composer's unsent message, a different shape), and
  `cli/src/init/runInitWizard.tsx:55` (the init wizard's answers so far).
- **`absentReason`** (`harness/src/utils/files/fsEntryExists.ts:18`)
  returns a `boolean` ("whether this failure means nothing is at the
  path") under a noun that promises a reason; 52 files (harness 23, texra
  17, cli 8, desktop 4). The root guide cites it by name.
- **New: `ModelOption` and `ModelOptionData`.** `harness/src/model/computeModelOptions.ts:435`
  is a model's availability verdict (`availability`, `unavailableReason`,
  `usageRoute`, `published` config); `texra/src/shared/pickerOptions.ts:40-51`
  is a picker row (`label`, `provider`, `context`, `cost`, `hint`, …).
  The only thing telling them apart is the suffix `Data`, and the one
  function that maps one to the other already uses the right words:
  `optionRow(verdict: ModelOption): ModelOptionData`
  (`texra/src/model/modelOptions.ts:72`). Its siblings `AgentOptionData`
  and `TeamOptionData` (`pickerOptions.ts:60,88`) carry the same suffix
  with no second type to tell apart.

**The design decision behind it.** Each name was chosen inside its own
package; the second declaration never saw the first.

**The better design.** `PluginFactRow` for the harness's (an SDK rename;
the app's stays `PluginRow`, or `PluginsPageRow`); `TranscriptUpdate` for
the harness's `Draft`, `ComposerDraft` for the two composers (one shape
once the GUI and TUI composers share it, which NM10(g) tied to J's
`RunSurface`), `InitAnswers` for the wizard's; `meansAbsent(error)` with
the root guide's line; `ModelVerdict` for the harness type and
`ModelPickerRow`, `AgentPickerRow`, `TeamPickerRow` for the three picker
rows (or drop `Data` from all three once the verdict has its own name).

**What we give up, and risk.** Rename churn (about 90 files for
`absentReason` and the picker rows together). `PluginRow` and
`ModelOption` are on the harness's public entries (`plugins.ts:54`,
`host.ts:153`): SDK 0.x renames, under "Needs your eye".

**How I tried to refute it.** Read each pair's declarations to confirm the
fields differ (no pair is one type exported twice); checked that no
persisted or wire string carries these names (they are TypeScript names
only; the picker rows travel in the host snapshot as schema fields, not by
type name).

## LC-6: The shipped API reference still names internal source files, and `ModelInvoker`'s header narrates its steps

- flags: comment restates code (implementation documentation in an interface)
- package: harness
- kind: docs
- size: S
- earlier: IC6 (open, no owner). `ITool.describe` is gone and
  `withPerKeyLane`'s doc now states the `Semaphore` it runs on, so those
  two parts are done; these are the rest.
- open PR: none

**Evidence.** Generated `packages/harness/docs/api/*.md` lines that send a
package reader to a file they cannot open, with their sources:
`host.md:413` (`platform/appSignals.ts:7`, "`shared/schemas/sessionEvent.ts`"),
`host.md:495-541` (`appSignals.ts`'s "Consumed by" paragraphs naming
`settingsViewBody.ts`, `extensionHostRequests.ts`, `hostSnapshotSource.ts`,
`settingsAgentCommands.ts`: app and host files, IC4's convention, still
open), `host.md:1080` (`agent/runtime/helperModel.ts:64`,
"`run/modelCall.ts`"), `plugins.md:122` (`agent/trace/AgentTrace.ts:64`,
"see `helpers.ts`", false since the rename to `traceLogs.ts`; HR-2 fixes the
source, and docgen then fixes this line), `plugins.md:599`
(`tools/core/definition.ts:52`), `plugins.md:1522`
(`tools/approval/toolEditApproval.ts:71`), `plugins.md:2064`
(`agent/core/tools/ToolTypes.ts:29`, "`agent/runtime/loop/toolGuard.ts` is
the one place"), `host.md:2563` (`shared/usageLog.ts:32`, a Supabase
function path). `ModelInvoker.ts:1-20` still walks the steps of a turn
(`prepareTurn`, the `attempt` row, the stream bridged, `nextAttempt`) with
"the folded `RunState`" in its third line; `invoke` itself has no doc.

**The better design.** Each shipped doc says what the caller gets ("the
run loop checks these before the body runs"; "one completion on the
helper binding, gated and priced; no row is written"); the path goes. The
`AppSignals` entries keep their emitter and drop the host files (IC4's
open convention decides that part). `ModelInvoker`'s header becomes a
contract for `invoke` (which outcomes return, which rows are committed
when it returns), and the step list stays at the steps.

**What we give up, and risk.** A source pointer for a reader with the
repo checked out; their editor's "go to definition" is the better one.

**How I tried to refute it.** Regenerated nothing; matched each `docs/api`
line to its source by grep, and checked that the paths named are internal
(not exported entries).

## Good modules in this area

- `harness/src/effect/sessions.ts`'s `Session` and `Run` members: each says
  what it promises and how it fails. Still accurate where read (the one
  word to change is LC-3's `settled`).
- `harness/src/utils/files/fsDurability.ts`'s two listings
  (`readDirectoryTyped`, `readDirectoryTypedTolerant`, `:198-262`): each doc
  states what a symlink and an unreadable entry become, which is exactly
  what LC-1's two call-site comments get wrong; the callee is the right
  home for it.
- `harness/src/agent/runtime/agentToolResolution.ts:1-30`: a numbered
  module contract whose field docs point back at its own steps ("step 2"),
  not at a document.
- `texra/src/shared/constants/latexToolchain.ts` and
  `packages/texra/test/model/PinnedModels.vitest.ts`: where a comment says a
  suite pins a fact, the suite exists and checks it (the opposite of IC1's
  eight).
- `@ui/copy/*` (`texra/src/ui/copy/`): one home per user-visible word,
  which is why the refused words in strings a person reads are few (LC-3).

## Already settled, left alone

- Persisted and wire spellings: `child.park`, `followup.*` and the other
  row types (`rowVersions.ts`), `desktop:settlePrompt`, the `*Refused` and
  `RunAdmissionClosed` `_tag`s, span names (`llm.settleTurn`,
  `LeanServer.openAndSettle`), settings keys (root `AGENTS.md`, "Plain
  names and comments").
- `rowVersions.ts`' version log naming fields that no longer exist
  (`allowBypass`, `userRetryable`, `quotaFallback`, …): the log is the bump
  rule, settled in IC's "Already settled".
- `withPerKeyLane` (`SessionEvents` too): documented API names the root
  guide exempts.
- NM10(a) `ScriptCallStatus` (catalogue: the two statuses read different
  sources) and NM10(h) (`RunView` ×2: HS-5 this round).
- Issue numbers beside a stated reason (`commands.ts:82-83` `#3782`,
  `stateSettings.ts` `#11173`): regression pointers, not citations.
- GitHub "transition" in `tools/github/repoPoller.ts` and `prTypes.ts`: a
  pull request's state change, the domain's own word.
- "grammar" for a string format (`skillName.ts:8`,
  `diffFileNameManager.ts:20`, Monaco grammars): counted in LC-3's table,
  not listed for renaming; the table's row targets state-machine
  vocabulary.
- Vague file names: the 12 `*Utils.ts` files are each named for one topic
  (`mimeUtils`, `execUtils`, `latexParsingUtils`, …); none holds unrelated
  exports. NM10(j)'s five landed. Few instances; no finding.

## Dropped on verification

17 candidates: `RunTrace.lost` (`sessionEvents.ts:117`, loose but true);
`PinnedModels.vitest.ts` and `protocolStability.vitest.ts` (exist, check
what is claimed); `setModelEnabled` "the only writer of
`MODEL_SELECTION_KEY`" (true: the CLI goes through it,
`cli/src/runtime/models/enabledModels.ts:109`); `lineageMapping.ts`'s "one
caller" (the two importers take only `pairOutputsWithBases`, as the
header says); `killPolicy.ts:2`'s `ALLOW_ORCHESTRATOR_KILL` (the setting
exists under `_SETTING`); `memoryMeta.ts:48` and `LoogleTool.ts:241`
"backward-compatible" (a hand-written memory file without frontmatter and
a single-query reply are current inputs, not a legacy format: wording
only); `desktopShortcutRegistry.ts:82`, `databaseLayer.ts:97`,
`SubscriptionOAuthCoordinator.ts:203` (LC-2's refutation);
`agentToolResolution.ts`'s "step 2/3" (its own header's steps); the
`withPerKeyLane` and `ITool.describe` parts of IC6 (done); the `*Info` /
`*Data` exported names other than LC-5's pair (each the only type of its
name); the `transition` and `grammar` uses above; `codexImport.ts:9`'s
`findCodexPath()` (the Codex SDK's own function).
